import { createHash } from "node:crypto";
import { platform } from "node:os";
import {
  blobs,
  ensureBuiltInVocabulary,
  facets,
  facetValues,
  grants,
  newId,
  objects,
  objectTags,
  tenants,
  versions,
  zones,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase } from "@openhoard/core-db/testing";
import {
  saveCard,
  saveEmbeddings,
  saveExtract,
  searchObjects,
  suggestTitles,
  VIEW_TRANSACTION,
  type SearchTuning,
  type ViewRequest,
} from "@openhoard/core-catalog";
import {
  addMember,
  createGroup,
  createUser,
  lockUser,
  resolvePrincipal,
} from "@openhoard/core-identity";
import { Authorizer, createCedarEngine, type AuthzClient } from "@openhoard/core-policy";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessModel } from "../tenant/access.js";
import { generateTenant } from "../tenant/generate.js";
import type { FakeItem, FakeTenant } from "../tenant/types.js";
import { assertNoLeaks, runLeakHarness, type ContentCanary } from "./harness.js";
import type { SearchUnderTest } from "./types.js";

/*
 * T-504, and T-501..T-503 (keyword, vector and hybrid search), against the real thing: a fake
 * tenant imported into the database the way a correct permission import would (source ACLs as
 * object grants, sites' groups as groups, guests as guest users, sharing links as nothing),
 * then core/catalog searchObjects() probed by the leak harness as each user, whose principal
 * core/identity resolves from the database.
 *
 * Files are owned by a local account the harness never probes, so the owner permit can't hide
 * a leak, and the tenant's default visibility is hidden: what a member may find is exactly what
 * the ACLs let them read, which is the harness's ground truth.
 *
 * Every file has content, as enrichment would store it: extracted text (its labels, its canary
 * and body words), a summary, and vectors of both. Twelve restricted files also carry content
 * canaries, tokens that appear only in their text (`secret-…`) or only in their summary
 * (`gist-…`, which the vectors find too). Some files are local-only or commercial-only, and
 * some are flagged as prompt injections (metadata-only for every AI client): a caller may be
 * matched on a file's content only where the client's trust reaches its exposure (T-604).
 */

let db: Database;
let tenant: FakeTenant;
let tenantId: string;
const userIds = new Map<string, string>(); // fake user id → database user id
const itemIds = new Map<string, string>(); // database object id → fake item id
const exposureOf = new Map<string, "full" | "commercial-only" | "local-only" | "flagged">();
const contentCanaries: ContentCanary[] = [];
const MODEL = "stub/hash";
const DIMENSIONS = 384;

const chunks = <T>(list: readonly T[], size = 500): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, n) =>
    list.slice(n * size, (n + 1) * size),
  );
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** core/models' stub embedding (clients.ts stubEmbedding()): hashed words, unit length. */
function embed(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
    const bucket = (h >>> 0) % DIMENSIONS;
    v[bucket] = (v[bucket] ?? 0) + (h >>> 31 === 1 ? -1 : 1);
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v.map((_, i) => (i === 0 ? 1 : 0)) : v.map((x) => x / norm);
}
const hex = (n: number) => (0x10000000 + n).toString(16);
const timeout = (ms: number) => (platform() === "win32" ? ms * 4 : ms);
/**
 * The runs beyond the first probe the same code on the same engine (PGlite, WASM) with other
 * clients and plans, so they run where the runner is fast (Linux); Windows and macOS runners
 * are several times slower, and the first run already probes content there too.
 */
const everyRun = platform() === "linux";

beforeAll(async () => {
  tenant = generateTenant({ items: 600, seed: "catalog-search" });
  db = await openTestDatabase();
  tenantId = newId("tenant");
  const zoneId = newId("zone");
  const files = tenant.items.filter((i) => i.kind === "file");
  const versionOf = new Map<string, { objectId: string; versionId: string }>();
  await db.withTenant(tenantId, async (tx) => {
    await tx.insert(tenants).values({
      id: tenantId,
      name: "Fake",
      defaultVisibility: "hidden",
      defaultExposure: "full",
    });
    await tx.insert(zones).values({ tenantId, id: zoneId, kind: "indexed", name: "SharePoint" });
    await ensureBuiltInVocabulary(tx, tenantId);

    for (const u of tenant.users) {
      const user = await createUser(tx, tenantId, {
        email: u.upn,
        displayName: u.displayName,
        kind: u.guest ? "guest" : "member",
        source: "local",
      });
      userIds.set(u.id, user.id);
    }
    const owner = await createUser(tx, tenantId, {
      email: "import@hoard.test",
      displayName: "Import",
      source: "local",
    });
    const groupIds = new Map<string, string>();
    for (const g of tenant.groups) {
      const group = await createGroup(tx, tenantId, { name: g.displayName, source: "local" });
      groupIds.set(g.id, group.id);
      for (const m of g.members) {
        await addMember(tx, tenantId, group.id, userIds.get(m) as string, "local");
      }
    }
    const guestByUpn = new Map(
      tenant.users.filter((u) => u.guest).map((u) => [u.upn, userIds.get(u.id) as string]),
    );
    const principalOf = (p: string): string | undefined => {
      if (p.startsWith("user:")) return `user:${userIds.get(p.slice(5)) as string}`;
      if (p.startsWith("group:")) return `group:${groupIds.get(p.slice(6)) as string}`;
      if (p.startsWith("guest:")) {
        const id = guestByUpn.get(p.slice(6));
        return id === undefined ? undefined : `user:${id}`;
      }
      return undefined; // anyone-with-link: a link is not a principal
    };

    const labels = new Map<string, Set<string>>();
    const objectRows = [];
    const versionRows = [];
    const blobRows = [];
    const tagRows = [];
    const grantRows = [];
    for (const [n, item] of files.entries()) {
      const objectId = newId("object");
      const versionId = newId("version");
      itemIds.set(objectId, item.id);
      versionOf.set(item.id, { objectId, versionId });
      const blobId = `b3t:${n.toString(16).padStart(64, "0")}`;
      blobRows.push({ tenantId, id: blobId, size: item.size });
      objectRows.push({
        tenantId,
        id: objectId,
        zoneId,
        title: item.name,
        ownerId: `user:${owner.id}`,
      });
      versionRows.push({
        tenantId,
        id: versionId,
        objectId,
        seq: 1,
        blobId,
        mime: item.mime,
        processedAt: sql`now()`,
      });
      for (const label of new Set(item.labels)) {
        const [facet, value] = label.split(":") as [string, string];
        if (!value) continue;
        (labels.get(facet) ?? labels.set(facet, new Set()).get(facet))?.add(value);
        tagRows.push({
          tenantId,
          objectId,
          facet,
          value,
          source: "rule" as const,
          appliedBy: "rule:import",
          confidence: 1,
        });
      }
      // Exposure: some files local-only or commercial-only, some flagged as injections.
      const exposure =
        n % 7 === 2
          ? "flagged"
          : n % 5 === 1
            ? "local-only"
            : n % 5 === 3
              ? "commercial-only"
              : "full";
      exposureOf.set(item.id, exposure);
      if (exposure !== "full") {
        tagRows.push({
          tenantId,
          objectId,
          facet: exposure === "flagged" ? "risk" : "level",
          value: exposure === "flagged" ? "injection" : exposure,
          source: "rule" as const,
          appliedBy: "rule:import",
          confidence: 1,
        });
      }
      for (const principal of new Set(item.acl.map((a) => principalOf(a.principal)))) {
        if (principal === undefined) continue;
        grantRows.push({
          tenantId,
          id: newId("grant"),
          principal,
          role: "read" as const,
          objectId,
          grantedBy: "system:import",
          expiresAt: null,
        });
      }
    }
    await tx
      .insert(facets)
      .values([
        ...[...labels.keys()].map((key) => ({ tenantId, key, label: key, public: key === "type" })),
        { tenantId, key: "level", label: "Level" },
      ]);
    await tx.insert(facetValues).values([
      ...[...labels].flatMap(([facet, values]) =>
        [...values].map((value) => ({ tenantId, facet, value, label: value, approved: true })),
      ),
      ...(["local-only", "commercial-only"] as const).map((exposure) => ({
        tenantId,
        facet: "level",
        value: exposure,
        label: exposure,
        approved: true,
        exposure,
      })),
    ]);
    for (const rows of chunks(blobRows)) await tx.insert(blobs).values(rows);
    for (const rows of chunks(objectRows)) await tx.insert(objects).values(rows);
    for (const rows of chunks(versionRows)) await tx.insert(versions).values(rows);
    for (const rows of chunks(tagRows)) await tx.insert(objectTags).values(rows);
    for (const rows of chunks(grantRows)) await tx.insert(grants).values(rows);

    // People who have left keep their grants on record but can't sign in.
    for (const u of tenant.users.filter((u) => !u.active)) {
      await lockUser(tx, tenantId, userIds.get(u.id) as string, "system:import");
    }
  });

  // Content, as enrichment stores it: text, summary and vectors of both.
  const restricted = files.filter((i) => i.canary);
  const planted = new Set(restricted.slice(0, 12).map((i) => i.id));
  for (const batch of chunks(files, 100)) {
    await db.withTenant(tenantId, async (tx) => {
      for (const item of batch) {
        const n = files.indexOf(item);
        const { objectId, versionId } = versionOf.get(item.id) as {
          objectId: string;
          versionId: string;
        };
        const secret = planted.has(item.id) ? `secret-${hex(n)}` : "";
        const gist = planted.has(item.id) ? `gist-${hex(n)}` : "";
        if (planted.has(item.id)) {
          contentCanaries.push(
            { itemId: item.id, token: secret },
            { itemId: item.id, token: gist },
          );
        }
        const text = `labels: ${item.labels.join(" ")}\nreference: ${item.canary ?? ""}\n${secret}\nquarterly figures and notes for the team`;
        const summary = `Summary of the file with reference ${gist || "none"} for the record`;
        await saveContent(tx, { objectId, versionId, text, summary });
      }
    });
  }
}, timeout(240_000));
afterAll(() => db?.close());

async function saveContent(
  tx: Tx,
  input: { objectId: string; versionId: string; text: string; summary: string },
) {
  const { objectId, versionId, text, summary } = input;
  await saveExtract(tx, tenantId, {
    objectId,
    versionId,
    status: "extracted",
    kind: "text",
    text,
    truncated: false,
    metadata: {},
    signals: [],
    warnings: [],
    failure: null,
    extractor: "fixture/1",
  });
  await saveCard(tx, tenantId, {
    objectId,
    versionId,
    status: "summarized",
    summary,
    providerId: "stub",
    providerKind: "local",
    model: "stub",
    promptVersion: "fixture-1",
    filtered: 0,
    inputTokens: 1,
    outputTokens: 1,
  });
  await saveEmbeddings(tx, tenantId, {
    objectId,
    versionId,
    model: MODEL,
    providerKind: "local",
    items: [
      { part: "summary", seq: 0, textHash: sha256(summary), embedding: embed(summary) },
      { part: "chunk", seq: 0, textHash: sha256(text), embedding: embed(text) },
    ],
  });
}

const cedar = new Authorizer(createCedarEngine());
const FIRST_PARTY: AuthzClient = { id: "openhoard-web", trust: "first-party" };
const TAG = /^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * searchObjects() and suggestTitles() as the harness drives them: the caller's principal comes
 * from the database, the query's words are embedded (as core/models embedQuery() would, with the
 * stub). `widen` adds grants the caller doesn't hold, to show the harness catches a leak.
 */
const searchAs = (
  options: {
    widen?: readonly string[];
    client?: AuthzClient;
    tuning?: SearchTuning;
    authz?: Authorizer;
  } = {},
): SearchUnderTest => {
  const { widen = [], client = FIRST_PARTY, tuning = {}, authz = cedar } = options;
  const as = <T>(userId: string, work: (tx: Tx, request: ViewRequest) => Promise<T>) =>
    db.withTenant(
      tenantId,
      async (tx) => {
        const principal = await resolvePrincipal(tx, tenantId, userIds.get(userId) as string);
        if (!principal) throw new Error(`no principal for ${userId}`);
        return work(tx, {
          principal: { ...principal, objectGrants: [...principal.objectGrants, ...widen] },
          client,
        });
      },
      VIEW_TRANSACTION,
    );
  return {
    search: (r) =>
      as(r.userId, async (tx, request) => {
        const words = r.query
          .split(/\s+/)
          .filter((w) => w !== "" && !TAG.test(w))
          .join(" ");
        const result = await searchObjects(
          tx,
          tenantId,
          authz,
          request,
          {
            query: r.query,
            limit: Math.min(r.limit ?? 20, 100),
            ...(words === "" ? {} : { vectors: [{ model: MODEL, vector: embed(words) }] }),
            snippets: true,
          },
          tuning,
        );
        return {
          hits: result.hits.map((view, i) => ({
            id: itemIds.get(view.id) ?? view.id,
            title: view.title,
            card: { ...view, explanation: result.explanations[i] },
          })),
          total: result.total,
          facets: result.facets,
        };
      }),
    autocomplete: (r) =>
      as(r.userId, (tx, request) =>
        suggestTitles(tx, tenantId, cedar, request, {
          prefix: r.prefix,
          limit: Math.min(r.limit ?? 10, 50),
        }),
      ),
  };
};

/** Whether a client of this trust may have the content of a file of this exposure (T-604). */
const reaches = (trust: AuthzClient["trust"], item: FakeItem) => {
  const exposure = exposureOf.get(item.id);
  if (trust === "first-party") return true;
  if (exposure === "flagged") return false;
  if (trust === "local") return true;
  if (trust === "commercial") return exposure !== "local-only";
  return exposure === "full";
};
const contentVisibleTo =
  (trust: AuthzClient["trust"], also: (item: FakeItem) => boolean = () => true) =>
  (userId: string, item: FakeItem) =>
    new AccessModel(tenant).canRead(userId, item) && reaches(trust, item) && also(item);

describe("searchObjects and suggestTitles under the leak harness (T-504, T-505, T-501..T-503)", () => {
  it(
    "leaks nothing through results, totals, facets, suggestions, snippets or card text, and finds what callers may read",
    async () => {
      const report = await runLeakHarness({
        tenant,
        target: searchAs(),
        sampleUsers: everyRun ? 8 : 4,
        contentCanaries,
      });
      assertNoLeaks(report);
      expect(report.canaries).toBeGreaterThan(0);
      expect(report.found).toBeGreaterThan(0);
      // Every canary a caller may read is found: no pack permits here, so option 1 misses none.
      expect(report.found).toBe(report.readableCanaryProbes);
      expect(report.contentFound).toBe(report.readableContentProbes);
    },
    timeout(240_000),
  );

  for (const trust of ["commercial", "consumer"] as const) {
    it.runIf(everyRun)(
      `matches a ${trust} AI client on content only where the file's exposure reaches it (T-604)`,
      async () => {
        const report = await runLeakHarness({
          tenant,
          target: searchAs({ client: { id: `ai-${trust}`, trust } }),
          sampleUsers: 3,
          contentCanaries,
          contentVisible: contentVisibleTo(trust),
        });
        assertNoLeaks(report);
        // Titles still find every file the caller reads: metadata-only cards match on them.
        expect(report.found).toBe(report.readableCanaryProbes);
        expect(report.contentFound).toBe(report.readableContentProbes);
      },
      timeout(240_000),
    );
  }

  it.runIf(everyRun)(
    "keeps content matches gated on the HNSW path too (the threshold forced to 0)",
    async () => {
      const report = await runLeakHarness({
        tenant,
        target: searchAs({
          client: { id: "ai", trust: "commercial" },
          tuning: { exactLimit: 0, neighbours: 2 },
        }),
        sampleUsers: 3,
        contentCanaries,
        contentVisible: contentVisibleTo("commercial"),
      });
      assertNoLeaks(report);
      expect(report.contentFound).toBe(report.readableContentProbes);
    },
    timeout(240_000),
  );

  it.runIf(everyRun)(
    "matches no content of a file a pack forbids the caller to read",
    async () => {
      const forbidden = "sensitivity:confidential";
      const pack = new Authorizer(
        createCedarEngine({
          "pack/no-confidential": `forbid (principal, action == OpenHoard::Action::"read", resource) when { resource.allTags.contains("${forbidden}") };`,
        }),
      );
      const report = await runLeakHarness({
        tenant,
        target: searchAs({ authz: pack }),
        sampleUsers: 3,
        contentCanaries,
        contentVisible: contentVisibleTo("first-party", (i) => !i.labels.includes(forbidden)),
      });
      assertNoLeaks(report);
      expect(report.readableContentProbes).toBeGreaterThan(0);
      expect(report.contentFound).toBe(report.readableContentProbes);
    },
    timeout(240_000),
  );

  it(
    "catches a caller given grants they don't hold, and content matched for a metadata-only client",
    async () => {
      const widened = await runLeakHarness({
        tenant,
        target: searchAs({ widen: [...itemIds.keys()] }),
        sampleUsers: 2,
      });
      const surfaces = new Set(widened.leaks.map((l) => l.surface));
      for (const surface of ["results", "total", "facets", "autocomplete", "text"] as const)
        expect(surfaces).toContain(surface);
      expect(() => assertNoLeaks(widened)).toThrow(/permission leak/);
      // A first-party search judged as if it were a consumer AI client's: it matches content a
      // consumer client may not have, and the harness sees it.
      const access = new AccessModel(tenant);
      const reader = tenant.users.find(
        (u) =>
          u.active &&
          contentCanaries.some((c) => {
            const item = tenant.items.find((i) => i.id === c.itemId) as FakeItem;
            return access.canRead(u.id, item) && !reaches("consumer", item);
          }),
      );
      if (!reader) throw new Error("fixture: nobody reads a file a consumer client can't have");
      const content = await runLeakHarness({
        tenant,
        target: searchAs(),
        users: [reader.id],
        queries: [],
        contentCanaries,
        contentVisible: contentVisibleTo("consumer"),
      });
      expect(content.leaks.some((l) => l.surface === "results")).toBe(true);
    },
    timeout(240_000),
  );
});
