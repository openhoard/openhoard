import { readFileSync } from "node:fs";
import type { Tx } from "@openhoard/core-db";
import type { Authorizer } from "@openhoard/core-policy";
import { describe, expect, it } from "vitest";
import * as catalog from "./index.js";
import type { ViewRequest } from "./visibility.js";

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
 * - value: constants and error classes.
 */
const SURFACE = {
  gated: ["listVersions", "viewBySource", "viewObject", "viewObjects"],
  write: [
    "applyPack",
    "applyRuleTags",
    "approveReview",
    "clearPrimaryTag",
    "ingest",
    "markProcessed",
    "mergeReview",
    "proposeDisplayTitle",
    "proposePrimaryTag",
    "proposeTag",
    "rejectReview",
    "removeFromSource",
    "removePack",
    "setDisplayTitle",
    "setPrimaryTag",
  ],
  trusted: [
    "explainAccess",
    "explainLevels",
    "levelsFor",
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
    "APPLY_TRANSACTION",
    "DEFAULT_MIN_CONFIDENCE",
    "ExplainError",
    "GENERIC_TITLE",
    "INGEST_LIMITS",
    "IngestError",
    "MAX_OBJECT_IDS",
    "PackError",
    "TagError",
    "VIEW_TRANSACTION",
  ],
} as const;

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
      const gate = name === "viewObjects" ? /\.authorize\(/ : /\bviewObjects?\(/;
      expect(text, `${name} doesn't decide through the gate`).toMatch(gate);
    }
    // The gate reads decisions before it builds any view: canRead feeds decideRead.
    expect(String(catalog.viewObjects)).toMatch(/action:\s*["']read["'][\s\S]*decideRead/);
  });

  it("keeps every gated read in read.ts snapshot-first, querying only source refs before the gate", () => {
    const text = source("./read.ts");
    const starts = [...text.matchAll(/^export async function (\w+)/gm)];
    const names = starts.map((m) => m[1]).sort();
    expect(names).toEqual(SURFACE.gated.filter((n) => n !== "viewObjects").sort());
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

  it("answers every gated read with nothing for a hidden file and a caller authorize() refuses", async () => {
    const { openTestDatabase, seedTenant } = await import("@openhoard/core-db/testing");
    const db = await openTestDatabase();
    try {
      const t = await seedTenant(db, 1);
      const deny = {
        authorize: () => ({ allow: false, kind: "no-permit", reason: "deny", policies: [] }),
      } as unknown as Authorizer;
      const request: ViewRequest = {
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

  it("gives pure functions no database handle", () => {
    for (const name of SURFACE.pure) {
      expect(typeof exported[name], name).toBe("function");
      expect(String(exported[name]), name).not.toMatch(/\btx\b|\bqueryRows\b/);
    }
  });
});
