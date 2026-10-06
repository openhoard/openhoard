import { exportAudit } from "@openhoard/core-audit";
import {
  addGrant,
  facets,
  facetValues,
  newId,
  objects,
  tenants,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, grantAdmin, lockUser, resolvePrincipal } from "@openhoard/core-identity";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideReview,
  ReviewAccessError,
  reviewInbox,
  reviewItemFor,
  type ReviewDecision,
} from "./review-inbox.js";
import { primaryTagOf, proposePrimaryTag } from "./primary.js";
import { listOpenReviews, proposeTag, TagError, tagsForDecisions } from "./tagging.js";
import { levelsFor, markProcessed, VIEW_TRANSACTION, viewObjects } from "./visibility.js";

/*
 * T-1403: the review inbox as a person sees it. The done-when: a tag an assistant proposed is
 * approved by someone who may tag the file, and a grant on that tag then lets its holder read
 * the file.
 */

const authz = new Authorizer(createCedarEngine());
const WEB = { id: "openhoard-web", trust: "first-party" } as const;
let db: Database;
let t: SeededTenant;
/** May tag the seeded file (a write grant on it). */
let editor: string;
/** Reads the seeded file, no more (the seeded group's grant). */
let reader: string;
/** Holds a read grant on `client:globex`, which the file doesn't carry yet. */
let globex: string;

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const view = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work, VIEW_TRANSACTION);
const person = async (name: string) =>
  (
    await inTenant((tx) =>
      createUser(tx, t.tenantId, {
        email: `${name}@example.com`,
        displayName: name,
        source: "local",
        kind: "member",
      }),
    )
  ).id;

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  editor = await person("ed");
  globex = await person("gia");
  reader = t.userId;
  await inTenant(async (tx) => {
    await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
    await tx
      .insert(facets)
      .values({ tenantId: t.tenantId, key: "sensitivity", label: "Sensitivity", single: true });
    const value = (facet: string, v: string) => ({
      tenantId: t.tenantId,
      facet,
      value: v,
      label: v,
      approved: true,
    });
    await tx
      .insert(facetValues)
      .values([
        value("client", "globex"),
        value("client", "initech"),
        value("sensitivity", "internal"),
        value("sensitivity", "public"),
      ]);
    await addGrant(tx, t.tenantId, {
      principal: `user:${editor}`,
      role: "write",
      target: { objectId: t.objectId },
      grantedBy: "user:admin",
    });
  });
});
afterEach(() => db?.close());

/** An assistant proposes a tag on the seeded file, as the `tag` tool does. */
async function proposed(tag: string, objectId = t.objectId): Promise<string> {
  const out = await inTenant((tx) =>
    proposeTag(
      tx,
      t.tenantId,
      { objectId, tag, source: "model", appliedBy: "model:agent/cli_x", confidence: 1 },
      { review: "agent" },
    ),
  );
  if (out.applied) throw new Error("applied");
  return out.reviewId;
}
const inbox = (userId: string, limit?: number) =>
  view((tx) => reviewInbox(tx, t.tenantId, authz, { userId }, limit));
const item = (userId: string, reviewId: string, how?: ReviewDecision) =>
  view((tx) => reviewItemFor(tx, t.tenantId, authz, { userId }, reviewId, how));
const decide = (userId: string, reviewId: string, how: ReviewDecision, actor?: string) =>
  inTenant((tx) =>
    decideReview(tx, t.tenantId, { reviewId, userId, ...(actor ? { actor } : {}) }, how),
  );
const code = (work: Promise<unknown>) =>
  work.then(
    () => "ok",
    (e: unknown) =>
      e instanceof ReviewAccessError || e instanceof TagError ? e.code : Promise.reject(e),
  );
/** Whether the person can read the seeded file. */
const reads = (userId: string) =>
  view(async (tx) => {
    const principal = await resolvePrincipal(tx, t.tenantId, userId);
    if (!principal) throw new Error("no principal");
    const [card] = await viewObjects(tx, t.tenantId, authz, { principal, client: WEB }, [
      t.objectId,
    ]);
    return card?.shape === "card" && card.readable;
  });
interface Audited {
  actor: string;
  action: string;
  decision: string;
  object?: string;
  detail?: Record<string, unknown>;
}
const EMPTY = { items: [], more: false, capped: false };
const audited = async () => {
  const lines: string[] = [];
  await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Audited)
    .filter((r) => r.action === "tag.review");
};

describe("the review inbox", () => {
  it("lets someone who may tag the file approve an assistant's tag, and the tag's grant then applies", async () => {
    const reviewId = await proposed("client:globex");
    // A grant on the tag, made after the proposal: it gives nothing while the tag waits.
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: `user:${globex}`,
        role: "read",
        target: { tag: "client:globex" },
        grantedBy: "user:admin",
      }),
    );
    expect(await reads(globex)).toBe(false);

    expect(await inbox(editor)).toEqual({
      items: [
        {
          id: reviewId,
          objectId: t.objectId,
          title: "Report 1.docx",
          tag: "client:globex",
          reason: "agent",
          source: "model",
          appliedBy: "model:agent/cli_x",
          confidence: 1,
          createdAt: expect.any(Date) as Date,
          admin: false,
        },
      ],
      more: false,
      capped: false,
    });
    expect(await item(editor, reviewId)).toMatchObject({ id: reviewId, tag: "client:globex" });

    expect(await decide(editor, reviewId, { decision: "approve" })).toEqual({
      objectId: t.objectId,
      tag: "client:globex",
      applied: "client:globex",
      replaced: [],
      alsoClosed: 0,
    });
    expect(await reads(globex)).toBe(true);
    expect(
      (await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId))).grantable,
    ).toContain("client:globex");
    expect(await inbox(editor)).toEqual(EMPTY);
    expect(await audited()).toMatchObject([
      {
        actor: `user:${editor}`,
        decision: "allow",
        object: t.objectId,
        detail: { review: reviewId, tag: "client:globex", reason: "agent", outcome: "approved" },
      },
    ]);
    // Decided once.
    expect(await code(item(editor, reviewId))).toBe("not-found");
    expect(await code(decide(editor, reviewId, { decision: "reject" }))).toBe("already-resolved");
    expect(await audited()).toHaveLength(1);
  });

  it("shows an item only to those who may tag its file, admins included", async () => {
    const reviewId = await proposed("client:globex");
    const admin = await person("adm");
    await inTenant((tx) => grantAdmin(tx, t.tenantId, admin, "system:test"));
    // Reads the file, may not tag it.
    expect(await inbox(reader)).toEqual(EMPTY);
    expect(await code(item(reader, reviewId))).toBe("refused");
    // Can't read it: to them the item isn't there, as an unknown one isn't.
    for (const who of [globex, admin]) {
      expect(await inbox(who)).toEqual(EMPTY);
      expect(await code(item(who, reviewId))).toBe("not-found");
    }
    expect(await code(item(editor, "rev_00000000000000000000000000"))).toBe("not-found");
    expect(await code(item(editor, "'; drop table"))).toBe("not-found");
    expect(await code(inbox("usr_00000000000000000000000000"))).toBe("unknown-reviewer");
    expect(await code(item("usr_00000000000000000000000000", reviewId))).toBe("unknown-reviewer");
  });

  it("rejects and merges, each audited with who decided and who acted", async () => {
    const rejected = await proposed("client:globex");
    expect(
      await decide(editor, rejected, { decision: "reject" }, "system:admin-cli"),
    ).toMatchObject({ objectId: t.objectId, tag: "client:globex", applied: null });
    const merged = await proposed("client:initech");
    expect(await decide(editor, merged, { decision: "merge", into: "globex" })).toMatchObject({
      tag: "client:initech",
      applied: "client:globex",
    });
    const tags = await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId));
    expect(tags.grantable).toContain("client:globex");
    expect(tags.levels).not.toContain("client:initech");
    expect(await audited()).toMatchObject([
      {
        actor: "system:admin-cli",
        detail: { review: rejected, outcome: "rejected", reviewer: `user:${editor}` },
      },
      {
        actor: `user:${editor}`,
        detail: { review: merged, outcome: "merged", into: "client:globex" },
      },
    ]);
    // A refused decision writes nothing: no record, the item still open.
    const open = await proposed("client:initech");
    expect(await code(decide(editor, open, { decision: "merge", into: "nope" }))).toBe("invalid");
    expect(await audited()).toHaveLength(2);
    expect((await inbox(editor)).items.map((i) => i.id)).toEqual([open]);
  });

  it("replaces a single-value facet's value only when told to", async () => {
    await inTenant((tx) =>
      proposeTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: "sensitivity:internal",
        source: "user",
        appliedBy: `user:${editor}`,
        confidence: 1,
      }),
    );
    const reviewId = await proposed("sensitivity:public");
    expect((await item(editor, reviewId)).reason).toBe("conflict");
    expect(await code(decide(editor, reviewId, { decision: "approve" }))).toBe("conflict");
    expect(await decide(editor, reviewId, { decision: "approve", replace: true })).toMatchObject({
      replaced: ["sensitivity:internal"],
    });
    const tags = await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId));
    expect(tags.levels).toContain("sensitivity:public");
    expect(tags.levels).not.toContain("sensitivity:internal");
    expect(await audited()).toMatchObject([
      { detail: { outcome: "approved", replaced: "sensitivity:internal" } },
    ]);
    // Told to replace where nothing is replaced: nothing is said to have been.
    const plain = await proposed("client:globex");
    expect(await decide(editor, plain, { decision: "approve", replace: true })).toMatchObject({
      replaced: [],
    });
    expect((await audited())[1]?.detail).not.toHaveProperty("replaced");
  });

  it("lists the oldest first, says when there is more, and isn't starved by items on other files", async () => {
    // Many older items on a file the editor can't read.
    const other = await inTenant(async (tx) => {
      const id = newId("object");
      await tx.insert(objects).values({
        tenantId: t.tenantId,
        id,
        zoneId: t.zoneId,
        title: "Theirs.docx",
        ownerId: "user:someone",
      });
      await tx.insert(facetValues).values(
        Array.from({ length: 40 }, (_, i) => ({
          tenantId: t.tenantId,
          facet: "client",
          value: `v${i}`,
          label: `v${i}`,
          approved: true,
        })),
      );
      return id;
    });
    for (let i = 0; i < 40; i++) await proposed(`client:v${i}`, other);
    const first = await proposed("client:globex");
    const second = await proposed("client:initech");
    expect(await inbox(editor, 1)).toMatchObject({ items: [{ id: first }], more: true });
    expect(await inbox(editor)).toMatchObject({
      items: [{ id: first }, { id: second }],
      more: false,
      capped: false,
    });
    // Looking at one file a page: theirs is the second, found on the second page; with one
    // page allowed, the listing says files were left unlooked at.
    const paged = (pages: number) =>
      view((tx) =>
        reviewInbox(tx, t.tenantId, authz, { userId: editor }, 100, { files: 1, pages }),
      );
    expect(await paged(2)).toMatchObject({ items: [{ id: first }, { id: second }], capped: false });
    expect(await paged(1)).toEqual({ items: [], more: false, capped: true });
    await expect(inbox(editor, 0)).rejects.toThrow(RangeError);
    await expect(inbox(editor, 501)).rejects.toThrow(RangeError);
  });

  it("leaves the vocabulary to a tenant admin who may tag the file", async () => {
    const propose = (objectId: string, tag = "client:newco") =>
      inTenant(async (tx) => {
        const out = await proposeTag(tx, t.tenantId, {
          objectId,
          tag,
          source: "model",
          appliedBy: "model:test/m",
          confidence: 0.9,
          label: "Newco",
        });
        if (out.applied) throw new Error("applied");
        return out.reviewId;
      });
    // The same new value proposed on a file the editor can't read, and on one only they tag.
    const [other, own] = await inTenant(async (tx) => {
      const ids = [newId("object"), newId("object")] as const;
      await tx.insert(objects).values(
        ids.map((id, i) => ({
          tenantId: t.tenantId,
          id,
          zoneId: t.zoneId,
          title: `File ${i}.docx`,
          ownerId: i === 1 ? `user:${editor}` : "user:someone",
        })),
      );
      return ids;
    });
    const boss = await person("boss");
    await inTenant(async (tx) => {
      await grantAdmin(tx, t.tenantId, boss, "system:test");
      await addGrant(tx, t.tenantId, {
        principal: `user:${boss}`,
        role: "write",
        target: { objectId: t.objectId },
        grantedBy: "user:admin",
      });
    });
    const mine = await propose(t.objectId);
    const theirs = await propose(other);
    const owned = await propose(own);

    // The editor sees it, marked, and may neither approve nor reject it.
    expect((await inbox(editor)).items).toMatchObject([
      { id: mine, reason: "new-value", admin: true },
      { id: owned, admin: true },
    ]);
    for (const decision of ["approve", "reject"] as const) {
      const refused = await item(editor, mine, { decision }).catch((e: unknown) => e);
      expect(refused).toMatchObject({ code: "not-admin", objectId: t.objectId });
      // Asked to decide anyway: refused where it is written, nothing changed.
      expect(await code(decide(editor, mine, { decision }))).toBe("not-admin");
    }
    expect(await audited()).toEqual([]);
    // Merging it into an approved value is tagging the file: theirs to do.
    const typo = await propose(t.objectId, "client:glbx");
    await item(editor, typo, { decision: "merge", into: "globex" });
    await decide(editor, typo, { decision: "merge", into: "globex" });

    // The admin, who may tag that file, approves the value: it is the vocabulary's now.
    expect(await code(item(boss, theirs))).toBe("not-found");
    await item(boss, mine, { decision: "approve" });
    await decide(boss, mine, { decision: "approve" });
    // So the editor may decide the item on their own file, and rejecting it closes only that.
    expect((await inbox(editor)).items).toMatchObject([{ id: owned, admin: false }]);
    await item(editor, owned, { decision: "reject" });
    expect(await decide(editor, owned, { decision: "reject" })).toMatchObject({ alsoClosed: 0 });
    const open = await inTenant((tx) => listOpenReviews(tx, t.tenantId));
    expect(open.map((r) => r.id)).toEqual([theirs]);
  });

  it("closes every item proposing a new value an admin rejects, and says so", async () => {
    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor, "system:test"));
    const other = await inTenant(async (tx) => {
      const id = newId("object");
      await tx.insert(objects).values({
        tenantId: t.tenantId,
        id,
        zoneId: t.zoneId,
        title: "Theirs.docx",
        ownerId: "user:someone",
      });
      return id;
    });
    const ids: string[] = [];
    for (const objectId of [t.objectId, other]) {
      const out = await inTenant((tx) =>
        proposeTag(tx, t.tenantId, {
          objectId,
          tag: "client:newco",
          source: "model",
          appliedBy: "model:test/m",
          confidence: 0.9,
        }),
      );
      if (!out.applied) ids.push(out.reviewId);
    }
    expect(await decide(editor, ids[0] as string, { decision: "reject" })).toMatchObject({
      alsoClosed: 1,
    });
    expect(await audited()).toMatchObject([{ detail: { outcome: "rejected", alsoClosed: 1 } }]);
    expect(await inTenant((tx) => listOpenReviews(tx, t.tenantId))).toEqual([]);
  });

  it("leaves opening a file up past the tenant's default to a tenant admin", async () => {
    // The tenant keeps files to those who may read them, and their content from every AI.
    await inTenant((tx) =>
      tx
        .update(tenants)
        .set({ defaultVisibility: "hidden", defaultExposure: "metadata-only" })
        .where(eq(tenants.id, t.tenantId)),
    );
    await inTenant((tx) =>
      tx.insert(facetValues).values([
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "open",
          label: "Open",
          approved: true,
          visibility: "readable",
          exposure: "full",
        },
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "sealed",
          label: "Sealed",
          approved: true,
          visibility: "hidden",
          exposure: "metadata-only",
        },
      ]),
    );
    const levels = async () => {
      const found = await view((tx) => levelsFor(tx, t.tenantId, [t.objectId]));
      return found.get(t.objectId);
    };
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "metadata-only" });

    // A model's "open" waits, and approving it would put the first level on the file: one
    // looser than the default it replaces. Not the editor's, however it is decided.
    const open = await proposed("sensitivity:open");
    expect(await code(item(editor, open, { decision: "approve" }))).toBe("not-admin");
    expect(await code(decide(editor, open, { decision: "approve" }))).toBe("not-admin");
    // Nor by filing a harmless suggestion under it.
    const plain = await proposed("sensitivity:internal");
    for (const how of [
      { decision: "merge", into: "open" },
      { decision: "merge", into: "open", replace: true },
    ] as const) {
      expect(await code(item(editor, plain, how))).toBe("not-admin");
      expect(await code(decide(editor, plain, how))).toBe("not-admin");
    }
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "metadata-only" });

    // A value as tight as the default opens nothing: theirs. Nor does a value that sets no
    // level at all.
    await decide(editor, plain, { decision: "merge", into: "sealed" });
    expect(await levels()).toMatchObject({ visibility: "hidden", exposure: "metadata-only" });
    // With "sealed" on the file, "open" beside it changes nothing (the tightest wins), but
    // in its place it would: an admin's.
    expect(await code(decide(editor, open, { decision: "approve", replace: true }))).toBe(
      "not-admin",
    );
    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor, "system:admin-cli"));
    await decide(editor, open, { decision: "approve", replace: true });
    expect(await levels()).toMatchObject({ visibility: "readable", exposure: "full" });
  });

  it("leaves a file's first exposure level to a tenant admin when it lifts enrichment's ceiling", async () => {
    // The tenant's default is everything to every AI. A file nothing classifies still goes to
    // enrichment no further than providers on business terms (enrichmentExposure()).
    await inTenant((tx) =>
      tx.update(tenants).set({ defaultExposure: "full" }).where(eq(tenants.id, t.tenantId)),
    );
    await inTenant((tx) =>
      tx.insert(facetValues).values([
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "anyone",
          label: "Anyone",
          approved: true,
          exposure: "full",
        },
        {
          tenantId: t.tenantId,
          facet: "sensitivity",
          value: "business",
          label: "Business",
          approved: true,
          exposure: "commercial-only",
        },
      ]),
    );
    // "full" is no looser than the default, but it is the file's first classification.
    const anyone = await proposed("sensitivity:anyone");
    expect(await code(decide(editor, anyone, { decision: "approve" }))).toBe("not-admin");
    // One at the ceiling lifts nothing: the editor's.
    const business = await proposed("sensitivity:business");
    await decide(editor, business, { decision: "approve" });
  });

  it("leaves taking a restriction off a file to a tenant admin", async () => {
    // `restricted` hides the file; `internal` and `public` set nothing.
    await inTenant((tx) =>
      tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "restricted",
        label: "Restricted",
        approved: true,
        visibility: "hidden",
      }),
    );
    // A model's restriction, waiting: it tightens the file meanwhile, so turning it down loosens.
    const tighten = await proposed("sensitivity:restricted");
    expect((await inbox(editor)).items).toMatchObject([{ id: tighten, admin: true }]);
    expect(await code(item(editor, tighten, { decision: "reject" }))).toBe("not-admin");
    expect(await code(decide(editor, tighten, { decision: "reject" }))).toBe("not-admin");
    // Merging it into a value that sets nothing is turning it down by another name.
    for (const into of ["internal", "public"]) {
      expect(await code(item(editor, tighten, { decision: "merge", into }))).toBe("not-admin");
      expect(await code(decide(editor, tighten, { decision: "merge", into }))).toBe("not-admin");
    }
    // Into no value of the vocabulary, or into itself, it is refused for what it is.
    for (const into of ["nope", "restricted"]) {
      expect(await code(decide(editor, tighten, { decision: "merge", into }))).toBe("invalid");
    }
    // Into a value that hides the file as it does (and more), nothing is taken off: theirs.
    await inTenant((tx) =>
      tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "secret",
        label: "Secret",
        approved: true,
        visibility: "hidden",
        exposure: "metadata-only",
      }),
    );
    const tighter = await proposed("sensitivity:restricted", t.objectId);
    expect(tighter).toBe(tighten);
    await item(editor, tighten, { decision: "merge", into: "secret" });
    expect((await inTenant((tx) => listOpenReviews(tx, t.tenantId))).map((r) => r.id)).toEqual([
      tighten,
    ]);
    // Approving it only tightens: the editor's to do.
    await item(editor, tighten, { decision: "approve" });
    await decide(editor, tighten, { decision: "approve" });

    // Replacing the restriction with a looser value: an admin's, however it is decided.
    const loosen = await proposed("sensitivity:public");
    const merge = await proposed("sensitivity:internal");
    expect((await item(editor, loosen)).reason).toBe("conflict");
    for (const [id, how] of [
      [loosen, { decision: "approve", replace: true }],
      [loosen, { decision: "merge", into: "internal", replace: true }],
      [merge, { decision: "approve", replace: true }],
    ] as const) {
      expect(await code(item(editor, id, how))).toBe("not-admin");
      expect(await code(decide(editor, id, how))).toBe("not-admin");
    }
    // Turning the looser value down takes nothing off: theirs.
    await decide(editor, merge, { decision: "reject" });
    expect((await inTenant((tx) => tagsForDecisions(tx, t.tenantId, t.objectId))).levels).toContain(
      "sensitivity:restricted",
    );

    await inTenant((tx) => grantAdmin(tx, t.tenantId, editor, "system:test"));
    expect(await decide(editor, loosen, { decision: "approve", replace: true })).toMatchObject({
      replaced: ["sensitivity:restricted"],
    });
  });

  it("confirms a model's pick of the file's home, as the file's own matter", async () => {
    // The seeded tag is one the file carries, trusted: a model proposes it as the home.
    const out = await inTenant((tx) =>
      proposePrimaryTag(tx, t.tenantId, {
        objectId: t.objectId,
        tag: t.tag,
        appliedBy: "model:small",
        confidence: 0.8,
      }),
    );
    if (out.primary) throw new Error("expected a review");
    expect((await inbox(editor)).items).toMatchObject([
      { id: out.reviewId, reason: "primary", tag: t.tag, admin: false },
    ]);
    await item(editor, out.reviewId, { decision: "approve" });
    expect(await code(decide(editor, out.reviewId, { decision: "merge", into: "globex" }))).toBe(
      "invalid",
    );
    expect(await decide(editor, out.reviewId, { decision: "approve" })).toMatchObject({
      tag: t.tag,
      applied: t.tag,
    });
    expect(await inTenant((tx) => primaryTagOf(tx, t.tenantId, t.objectId))).toMatchObject({
      tag: t.tag,
    });
  });

  it("keeps, of the files asked about with `tag`, those the person reads and may tag", async () => {
    const guest = (
      await inTenant((tx) =>
        createUser(tx, t.tenantId, {
          email: "guest@elsewhere.example",
          displayName: "Guest",
          source: "local",
          kind: "guest",
        }),
      )
    ).id;
    const taggable = (userId: string, options = {}) =>
      view(async (tx) => {
        const principal = await resolvePrincipal(tx, t.tenantId, userId);
        if (!principal) throw new Error("no principal");
        const views = await viewObjects(
          tx,
          t.tenantId,
          authz,
          { principal, client: WEB },
          [t.objectId],
          { tag: true, ...options },
        );
        return views.map((v) => [v.shape, v.title]);
      });
    expect(await taggable(editor)).toEqual([["card", "Report 1.docx"]]);
    expect(await taggable(editor, { search: true })).toEqual([["card", "Report 1.docx"]]);
    // A reader, a member who sees only the title, and a guest with nothing: none.
    for (const who of [reader, globex, guest]) expect(await taggable(who)).toEqual([]);
  });

  it("decides for no one who is no longer current", async () => {
    const reviewId = await proposed("client:globex");
    await item(editor, reviewId);
    await inTenant((tx) => lockUser(tx, t.tenantId, editor, "user:admin"));
    expect(await code(decide(editor, reviewId, { decision: "approve" }))).toBe("unknown-reviewer");
    expect(await code(decide("nobody", reviewId, { decision: "approve" }))).toBe(
      "unknown-reviewer",
    );
    expect(await code(item(editor, reviewId))).toBe("not-found");
    expect(await audited()).toEqual([]);
  });
});
