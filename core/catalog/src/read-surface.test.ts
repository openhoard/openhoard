import { readFileSync } from "node:fs";
import type { Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { describe, expect, it } from "vitest";
import * as catalog from "./index.js";
import type { RecordedRequest } from "./visibility.js";

/*
 * T-206: no read path bypasses policy. Every runtime export of @openhoard/core-catalog is in
 * exactly one class below, and a new export fails this test until someone decides which:
 *
 * - gated: what a caller may see, decided through viewObjects() (authorize + levels);
 * - write: changes the catalog; the API authorizes the caller first (action `tag`, admin…),
 *   and answers a refusal the same whether or not the object exists: these functions' errors
 *   (TagError `unknown-object` vs `not-on-object`, say) do tell them apart;
 * - trusted: reads without a caller's policy, for enrichment, connectors, admins and the API's
 *   own checks; never exposed to a caller without a check of its own (listOpenReviews is the
 *   tenant's whole inbox: for its reviewers only);
 * - pure: no database at all;
 * - value: constants, classes that hold no database handle (error classes, ActivityBuffer).
 *
 * T-205: gated reads that serve one file record the caller's activity; listings and search
 * don't (RECORDING below).
 */
const SURFACE = {
  gated: [
    "listVersions",
    "openContent",
    "searchObjects",
    "suggestTitles",
    "viewBySource",
    "viewObject",
    "viewObjects",
  ],
  write: [
    "applyPack",
    "applyRuleTags",
    "approveReview",
    "clearPrimaryTag",
    "ingest",
    // Takes the object's lock for the enrichment step that writes after it.
    "lockCurrentVersion",
    "markProcessed",
    "markSuperseded",
    "mergeReview",
    "proposeDisplayTitle",
    "proposePrimaryTag",
    "proposeTag",
    "pruneActivity",
    "rejectReview",
    "removeFromSource",
    "removePack",
    "setDisplayTitle",
    "setPrimaryTag",
    "writeActivity",
  ],
  trusted: [
    // For enrichment (core/jobs): the exposure its tags give a file, before it is processed.
    "enrichmentExposure",
    "explainAccess",
    "explainLevels",
    "levelsFor",
    "listActivity",
    "listOpenReviews",
    "planPack",
    "planPackRemoval",
    "primaryTagOf",
    "sourceItemState",
    "tenantPolicies",
    "tenantRules",
  ],
  pure: [
    "blobIdOf",
    "canonicalJson",
    "contentHash",
    "contentHasher",
    "evaluateRules",
    "globMatch",
    "nonReaderTitle",
    "normalizeMime",
    "packPolicies",
    "parsePack",
    "reciprocalRankFusion",
    "runPackTests",
    "scopedBlobId",
    "validatePack",
    "validateRules",
  ],
  value: [
    "ACTIVITY_PAGE",
    "ActivityBuffer",
    "APPLY_TRANSACTION",
    "DEFAULT_MIN_CONFIDENCE",
    "ExplainError",
    "GENERIC_TITLE",
    "INGEST_LIMITS",
    "IngestError",
    "MAX_OBJECT_IDS",
    "PackError",
    "REPEAT_WINDOW_MS",
    "SEARCH_CANDIDATES",
    "TagError",
    "VIEW_TRANSACTION",
  ],
} as const;

/**
 * T-205: every gated read either serves one file, and records the caller's view or open, or
 * lists files (listings, search), and records nothing. Each is in exactly one of the two.
 */
const RECORDING = {
  listVersions: "view",
  openContent: "open",
  viewBySource: "view",
  viewObject: "view",
} as const;
const LISTING = ["searchObjects", "suggestTitles", "viewObjects"] as const;

/** The gated reads in search.ts, which reach viewObjects() through gatedMatches(). */
const SEARCH: readonly string[] = ["searchObjects", "suggestTitles"];

const exported = catalog as unknown as Record<string, unknown>;
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("the catalog's export surface", () => {
  it("classifies every export exactly once", () => {
    const listed = Object.values(SURFACE).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect(Object.keys(exported).sort()).toEqual([...listed].sort());
  });

  it("gates every caller-facing read through viewObjects, and viewObjects through authorize", () => {
    for (const name of SURFACE.gated) {
      expect(typeof exported[name], name).toBe("function");
      const text = String(exported[name]);
      // An imported call may be rewritten as `(0, module.viewObjects)(`.
      // search.ts reaches it through gatedMatches(), checked below.
      const gate =
        name === "viewObjects"
          ? /\.authorize\(/
          : SEARCH.includes(name)
            ? /\bgatedMatches\(/
            : /\bviewObjects?\)?\(/;
      expect(text, `${name} doesn't decide through the gate`).toMatch(gate);
    }
    // The gate reads decisions before it builds any view: canRead feeds decideRead.
    expect(String(catalog.viewObjects)).toMatch(/action:\s*["']read["'][\s\S]*decideRead/);
  });

  it("keeps every gated read in read.ts snapshot-first, querying only source refs before the gate", () => {
    const text = source("./read.ts");
    const starts = [...text.matchAll(/^export async function (\w+)/gm)];
    const names = starts.map((m) => m[1]).sort();
    expect(names).toEqual(
      SURFACE.gated.filter((n) => n !== "viewObjects" && !SEARCH.includes(n)).sort(),
    );
    for (const [i, m] of starts.entries()) {
      const whole = text.slice(m.index, starts[i + 1]?.index ?? text.length);
      // From the function's body on: its signature names it.
      const body = whole.slice(whole.search(/\): Promise<[^\n]*\{\n/));
      const gate = body.search(/\bviewObjects?\(/);
      expect(gate, `${m[1]} never reaches the gate`).toBeGreaterThan(-1);
      const before = body.slice(0, gate);
      // The snapshot check comes before any query, so the answer outside one never depends
      // on what exists.
      const snapshot = before.indexOf("requireSnapshot(");
      expect(snapshot, `${m[1]} doesn't check the snapshot first`).toBeGreaterThan(-1);
      const queried = [...before.matchAll(/\.from\((\w+)\)/g)].map((q) => q[1]);
      expect(
        queried.every((table) => table === "sourceRefs"),
        `${m[1]} reads ${queried.join()}`,
      ).toBe(true);
      const firstQuery = before.search(/\btx\s*\./);
      if (firstQuery > -1) expect(snapshot).toBeLessThan(firstQuery);
    }
  });

  it("lets search show, count and suggest only what the gate returns", () => {
    const text = source("./search.ts");
    const fn = (name: string) => {
      const from = text.indexOf(`async function ${name}(`);
      expect(from, name).toBeGreaterThan(-1);
      const next = text.slice(from + 1).search(/\n(export )?(async )?function /);
      return text.slice(from, next === -1 ? undefined : from + 1 + next);
    };
    // Each export checks the snapshot before anything reaches the database.
    for (const name of SEARCH) {
      const body = fn(name);
      expect(body.indexOf("requireSnapshot("), name).toBeGreaterThan(-1);
      expect(body.indexOf("requireSnapshot("), name).toBeLessThan(body.indexOf("gatedMatches("));
      expect(body, name).not.toMatch(/queryRows|\btx\s*\./);
    }
    // Hits, total, facets and suggestions come only from the gate's views.
    const search = fn("searchObjects");
    expect(search).toMatch(/hits: found\.views\.slice\(/);
    expect(search).toMatch(/total: found\.views\.length/);
    expect(search).toMatch(/for \(const view of found\.views\)[\s\S]*view\.tags/);
    expect(fn("suggestTitles")).toMatch(/for \(const view of found\.views\)[\s\S]*view\.title/);
    const gated = fn("gatedMatches");
    expect(gated).toMatch(/const views = [^;]*viewObjects\(/);
    expect(gated).toMatch(/views: views\.map\(/);
  });

  it("answers every gated read with nothing for a hidden file and a caller authorize() refuses", async () => {
    const { openTestDatabase, seedTenant } = await import("@openhoard/core-db/testing");
    const db = await openTestDatabase();
    try {
      const t = await seedTenant(db, 1);
      const deny = {
        authorize: () => ({ allow: false, kind: "no-permit", reason: "deny", policies: [] }),
      } as unknown as Authorizer;
      const request: RecordedRequest = {
        principal: {
          userId: "bo",
          groupIds: [],
          tagGrants: [t.tag],
          tagWriteGrants: [t.tag],
          objectGrants: [t.objectId],
          objectWriteGrants: [],
          guest: false,
          active: true,
        },
        client: { id: "openhoard-web", trust: "first-party" },
        activity: new catalog.ActivityBuffer(),
      };
      // One call per gated export: a new one fails here until it has a case.
      const CALLS: Record<(typeof SURFACE.gated)[number], (tx: Tx) => Promise<unknown>> = {
        viewObjects: (tx) => catalog.viewObjects(tx, t.tenantId, deny, request, [t.objectId]),
        viewObject: (tx) => catalog.viewObject(tx, t.tenantId, deny, request, t.objectId),
        viewBySource: (tx) =>
          catalog.viewBySource(tx, t.tenantId, deny, request, {
            source: "sharepoint",
            externalId: t.externalId,
          }),
        listVersions: (tx) => catalog.listVersions(tx, t.tenantId, deny, request, t.objectId),
        openContent: (tx) => catalog.openContent(tx, t.tenantId, deny, request, t.objectId),
        searchObjects: async (tx) =>
          (await catalog.searchObjects(tx, t.tenantId, deny, request, { query: "" })).hits,
        suggestTitles: (tx) =>
          catalog.suggestTitles(tx, t.tenantId, deny, request, { prefix: "report" }),
      };
      expect(Object.keys(CALLS).sort()).toEqual([...SURFACE.gated].sort());
      // The seeded file is unprocessed, so hidden to anyone authorize() refuses.
      for (const [name, call] of Object.entries(CALLS)) {
        const got = await db.withTenant(t.tenantId, call, catalog.VIEW_TRANSACTION);
        expect(got === null || (Array.isArray(got) && got.length === 0), name).toBe(true);
      }
    } finally {
      await db.close();
    }
  });

  it("sorts every gated read into recording or listing, and records through the request", () => {
    expect([...Object.keys(RECORDING), ...LISTING].sort()).toEqual([...SURFACE.gated].sort());
    const text = source("./read.ts");
    for (const name of Object.keys(RECORDING)) {
      const from = text.indexOf(`export async function ${name}(`);
      // To the end of the function: its closing brace is the first at the start of a line.
      const body = text.slice(from, text.indexOf("\n}\n", from) + 2);
      // The recorder is checked before anything is read, and something records.
      const check = body.indexOf("requireRecorder(");
      expect(check, name).toBeGreaterThan(-1);
      for (const read of [body.search(/\btx\s*\./), body.search(/\bviewObjects\(/)]) {
        if (read > -1) expect(check, name).toBeLessThan(read);
      }
      expect(body, name).toMatch(/\bnote(View|Activity)\(request,/);
    }
  });

  it("records one view or open for every gated read of one file, and nothing for listings", async () => {
    const { openTestDatabase, seedTenant } = await import("@openhoard/core-db/testing");
    const db = await openTestDatabase();
    try {
      const t = await seedTenant(db, 1);
      const allow = {
        authorize: () => ({ allow: true, kind: "allow", reason: "allow", policies: [] }),
      } as unknown as Authorizer;
      const deny = {
        authorize: () => ({ allow: false, kind: "no-permit", reason: "deny", policies: [] }),
      } as unknown as Authorizer;
      // First-party: the seeded file is unprocessed, so metadata-only to an AI client.
      const client = { id: "openhoard-web", trust: "first-party" } as const;
      const principal = {
        userId: "usr_01k5xr3c8v0q6m2d4n7p9s1t3w",
        groupIds: [],
        tagGrants: [],
        tagWriteGrants: [],
        objectGrants: [t.objectId],
        objectWriteGrants: [],
        guest: false,
        active: true,
      };
      const run = async (authz: Authorizer, name: (typeof SURFACE.gated)[number]) => {
        const activity = new catalog.ActivityBuffer();
        const request: RecordedRequest = { principal, client, activity };
        const calls: Record<(typeof SURFACE.gated)[number], (tx: Tx) => Promise<unknown>> = {
          viewObjects: (tx) => catalog.viewObjects(tx, t.tenantId, authz, request, [t.objectId]),
          viewObject: (tx) => catalog.viewObject(tx, t.tenantId, authz, request, t.objectId),
          viewBySource: (tx) =>
            catalog.viewBySource(tx, t.tenantId, authz, request, {
              source: "sharepoint",
              externalId: t.externalId,
            }),
          listVersions: (tx) => catalog.listVersions(tx, t.tenantId, authz, request, t.objectId),
          openContent: (tx) => catalog.openContent(tx, t.tenantId, authz, request, t.objectId),
          searchObjects: (tx) =>
            catalog.searchObjects(tx, t.tenantId, authz, request, { query: "report" }),
          suggestTitles: (tx) =>
            catalog.suggestTitles(tx, t.tenantId, authz, request, { prefix: "report" }),
        };
        const got = await db.withTenant(t.tenantId, calls[name], catalog.VIEW_TRANSACTION);
        return { got, events: activity.take() };
      };
      for (const name of SURFACE.gated) {
        const { got, events } = await run(allow, name);
        const type = (RECORDING as Record<string, string>)[name];
        if (type === undefined) {
          expect(LISTING as readonly string[], name).toContain(name);
          expect(events, `${name} is a listing: it records nothing`).toEqual([]);
          continue;
        }
        expect(got, name).not.toBeNull();
        expect(events, name).toEqual([
          {
            type,
            actor: `user:${principal.userId}`,
            objectId: t.objectId,
            versionId: type === "open" ? t.versionId : null,
            client,
          },
        ]);
        // What the caller may not know about leaves no trace either.
        expect((await run(deny, name)).events, `${name} refused`).toEqual([]);
      }
      // A read of one file without a recorder is refused, before it reads anything.
      const bare = { principal, client } as unknown as RecordedRequest;
      const unrecorded: Record<keyof typeof RECORDING, (tx: Tx) => Promise<unknown>> = {
        viewObject: (tx) => catalog.viewObject(tx, t.tenantId, allow, bare, t.objectId),
        viewBySource: (tx) =>
          catalog.viewBySource(tx, t.tenantId, allow, bare, {
            source: "sharepoint",
            externalId: t.externalId,
          }),
        listVersions: (tx) => catalog.listVersions(tx, t.tenantId, allow, bare, t.objectId),
        openContent: (tx) => catalog.openContent(tx, t.tenantId, allow, bare, t.objectId),
      };
      for (const [name, call] of Object.entries(unrecorded)) {
        await expect(
          db.withTenant(t.tenantId, call, catalog.VIEW_TRANSACTION),
          name,
        ).rejects.toThrow(/request\.activity/);
      }
      // What they record, the caller can write once the snapshot ends.
      const { events } = await run(allow, "openContent");
      const written = await db.withTenant(t.tenantId, (tx) =>
        catalog.writeActivity(tx, t.tenantId, events),
      );
      expect(written).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("gives pure functions no database handle", () => {
    for (const name of SURFACE.pure) {
      expect(typeof exported[name], name).toBe("function");
      expect(String(exported[name]), name).not.toMatch(/\btx\b|\bqueryRows\b/);
    }
  });
});
