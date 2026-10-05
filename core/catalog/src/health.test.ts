import {
  addGrant,
  blobs,
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  revokeGrants,
  sourceRefs,
  sourceShares,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  addMember,
  createGroup,
  createUser,
  grantAdmin,
  lockUser,
  retireUser,
  setProviderActive,
} from "@openhoard/core-identity";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthError, healthReport, type HealthOptions, type HealthSection } from "./health.js";
import { VIEW_TRANSACTION } from "./visibility.js";

/*
 * T-1001: the File Health Report's own rules, on rows written here. That it finds what a
 * synced SharePoint site holds is connectors/sharepoint's e2e test.
 */

let db: Database;
let t: SeededTenant;
let admin: string;
let n = 0;

const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(t.tenantId, work);
const person = (name: string, more: Partial<Parameters<typeof createUser>[2]> = {}) =>
  inTenant(async (tx) => {
    const email = `${name}@example.com`;
    return (
      await createUser(tx, t.tenantId, { email, displayName: name, source: "local", ...more })
    ).id;
  });

/** A live file with one version of `bytes` bytes of the content `content` names. */
async function file(
  title: string,
  more: {
    content?: number;
    bytes?: number;
    modifiedAt?: Date;
    createdBy?: string;
    modifiedBy?: string;
    unsynced?: boolean;
  } = {},
): Promise<string> {
  const id = newId("object");
  const content = more.content ?? 1000 + ++n;
  const blobId = `b3t:${content.toString(16).padStart(64, "0")}`;
  await inTenant(async (tx) => {
    await tx
      .insert(blobs)
      .values({ tenantId: t.tenantId, id: blobId, size: more.bytes ?? 100 })
      .onConflictDoNothing();
    await tx
      .insert(objects)
      .values({ tenantId: t.tenantId, id, zoneId: t.zoneId, title, ownerId: `user:${t.userId}` });
    await tx.insert(versions).values({
      tenantId: t.tenantId,
      id: newId("version"),
      objectId: id,
      seq: 1,
      blobId,
      mime: "text/plain",
    });
    if (more.unsynced) return;
    await tx.insert(sourceRefs).values({
      tenantId: t.tenantId,
      source: "sp",
      externalId: id,
      objectId: id,
      url: `https://sp.example/${id}`,
      sourceModifiedAt: more.modifiedAt ?? new Date(),
      sourceModifiedBy: more.modifiedBy ?? null,
      sourceCreatedBy: more.createdBy ?? null,
    });
  });
  return id;
}
const share = (
  objectId: string,
  kind: (typeof sourceShares.$inferInsert)["kind"],
  key = "",
  more: Partial<typeof sourceShares.$inferInsert> = {},
) =>
  inTenant((tx) =>
    tx.insert(sourceShares).values({
      tenantId: t.tenantId,
      source: "sp",
      objectId,
      kind,
      key,
      role: "read",
      inherited: false,
      matched: false,
      ...more,
    }),
  );
const grant = (objectId: string, principal: string, more: { expiresAt?: Date } = {}) =>
  inTenant((tx) =>
    addGrant(tx, t.tenantId, {
      principal,
      role: "read",
      target: { objectId },
      grantedBy: "user:admin",
      ...more,
    }),
  );
const report = (options: HealthOptions = {}, userId = admin) =>
  db.withTenant(
    t.tenantId,
    (tx) => healthReport(tx, t.tenantId, { userId }, options),
    VIEW_TRANSACTION,
  );
/** The titles a section lists, in its order. */
const titles = async (section: HealthSection, options: HealthOptions = {}) =>
  (await report(options)).sections[section].items.map((i) => i.title);

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  admin = await person("boss");
  await inTenant((tx) => grantAdmin(tx, t.tenantId, admin, "system:test"));
  // The seeded file is in nobody's way: deleted.
  await inTenant((tx) => tx.update(objects).set({ deletedAt: sql`now()` }));
});
afterEach(() => db?.close());

describe("the file health report", () => {
  it("is for tenant admins, and refuses options that mean nothing", async () => {
    const member = await person("mel");
    for (const who of [member, "usr_00000000000000000000000000", "nobody"]) {
      await expect(report({}, who)).rejects.toMatchObject({ code: "not-admin" });
    }
    for (const bad of [
      { limit: 0 },
      { limit: 10_001 },
      { staleAfterDays: 0 },
      { largeBytes: 0.5 },
      { wideGroupShare: 0 },
      { wideGroupShare: 1.5 },
      { wideGroupMin: 0 },
      { asOf: new Date(Number.NaN) },
    ]) {
      await expect(report(bad), JSON.stringify(bad)).rejects.toBeInstanceOf(HealthError);
    }
    // An empty tenant: nothing found, nothing failed.
    const empty = await report();
    expect(empty).toMatchObject({
      files: 0,
      bytes: 0,
      undated: 0,
      unattributed: 0,
      unknownPeople: 0,
      formerStaffInGroups: 0,
    });
    for (const finding of Object.values(empty.sections)) {
      expect(finding).toEqual({ count: 0, bytes: 0, items: [] });
    }
    // Outside a snapshot it refuses, as every read of many files does.
    await expect(inTenant((tx) => healthReport(tx, t.tenantId, { userId: admin }))).rejects.toThrow(
      /snapshot|repeatable/i,
    );
  });

  it("lists what the source shares with anyone, the organization and people outside", async () => {
    const open = await file("open.txt", { bytes: 300 });
    const org = await file("org.txt", { bytes: 200 });
    const out = await file("out.txt");
    const gone = await file("gone.txt");
    await file("plain.txt");
    await share(open, "link-anyone", "L1", { expiresAt: new Date("2999-01-01T00:00:00Z") });
    await share(org, "link-organization", "L2", { role: "write" });
    await share(org, "organization");
    await share(out, "guest", "pat@client.test", { matched: true });
    await share(out, "link-specific", "L3");
    await share(gone, "link-anyone", "L4");
    // A link that has lapsed since it was last synced shares nothing now.
    const was = await file("was.txt");
    await share(was, "link-anyone", "L5", { expiresAt: new Date("2020-01-01T00:00:00Z") });
    await share(was, "organization", "", { expiresAt: new Date("2020-01-01T00:00:00Z") });
    // People and groups the source names and OpenHoard doesn't know.
    const strangers = await file("strangers.txt");
    await share(strangers, "user", "aad-nobody");
    await share(strangers, "group", "sitegroup:s:5", { role: "write" });
    await inTenant((tx) =>
      tx
        .update(objects)
        .set({ deletedAt: sql`now()` })
        .where(eq(objects.id, gone)),
    );
    // A guest someone here gave a file to counts too, while the grant lasts.
    const guest = await person("gus", { kind: "guest" });
    const given = await file("given.txt");
    const lapsed = await file("lapsed.txt");
    const named = await file("named.txt");
    await grant(given, `user:${guest}`);
    // The source names the guest as it names any user: a grant it made, and no share row.
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: `user:${guest}`,
        role: "write",
        target: { objectId: named },
        grantedBy: "source:sp",
      }),
    );
    // And by invitation, matched: the share says it, the grant it brought isn't said again.
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: `user:${guest}`,
        role: "read",
        target: { objectId: out },
        grantedBy: "source:sp",
      }),
    );
    const old = await grant(lapsed, `user:${guest}`);
    await inTenant((tx) => revokeGrants(tx, t.tenantId, [old], "user:admin"));
    // (Nor one that has run out.)
    await grant(await file("ended.txt"), `user:${guest}`, {
      expiresAt: new Date(Date.now() + 1500),
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    // What a group the guest is in can read, the guest can: said with the group.
    const team = await inTenant(async (tx) => {
      const g = await createGroup(tx, t.tenantId, { name: "Project X", source: "local" });
      await addMember(tx, t.tenantId, g.id, guest, "local");
      await addMember(tx, t.tenantId, g.id, admin, "local");
      return g.id;
    });
    await grant(await file("project.txt"), `group:${team}`);
    // A second guest, named by the source as any user is, beside the first's invitation.
    const other = await person("ola", { kind: "guest" });
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: `user:${other}`,
        role: "read",
        target: { objectId: out },
        grantedBy: "source:sp",
      }),
    );
    await inTenant((tx) =>
      tx.update(sourceShares).set({ key: "GUS@example.com" }).where(eq(sourceShares.kind, "guest")),
    );

    const got = await report();
    expect(got.sections.publicLinks).toMatchObject({
      count: 1,
      bytes: 300,
      items: [
        {
          objectId: open,
          title: "open.txt",
          source: "sp",
          url: `https://sp.example/${open}`,
          bytes: 300,
          detail: "link-anyone (read, until 2999-01-01)",
        },
      ],
    });
    expect(got.sections.organization.items).toMatchObject([
      { title: "org.txt", detail: "link-organization (write); organization (read)" },
    ]);
    expect(got.sections.guests.items.map((i) => [i.title, i.detail]).sort()).toEqual([
      ["given.txt", "grant to gus (read)"],
      ["named.txt", "grant to gus (write)"],
      ["out.txt", "guest GUS@example.com (read); grant to ola (read)"],
      ["project.txt", "grant to gus in group Project X (read)"],
    ]);
    expect(got.sections.unmatched.items).toMatchObject([
      { title: "strangers.txt", detail: "group sitegroup:s:5 (write); user aad-nobody (read)" },
    ]);
    expect(got.files).toBe(11);
  });

  it("counts a group as the organization when it holds most of the tenant's current members", async () => {
    const people: string[] = [];
    for (let i = 0; i < 12; i++) people.push(await person(`p${i}`));
    const [most, few] = await inTenant(async (tx) => {
      const make = async (name: string, members: string[]) => {
        const g = await createGroup(tx, t.tenantId, { name, source: "local" });
        for (const m of members) await addMember(tx, t.tenantId, g.id, m, "local");
        return g.id;
      };
      return [await make("Everyone", people), await make("Team", people.slice(0, 5))];
    });
    const wide = await file("wide.txt");
    const narrow = await file("narrow.txt");
    await grant(wide, `group:${most}`);
    await grant(narrow, `group:${few}`);
    // 14 current members (these twelve, the admin, the seeded one): twelve is most of them.
    expect((await report()).sections.organization.items).toMatchObject([
      { title: "wide.txt", detail: "group Everyone (12 people, read)" },
    ]);
    // Asked for more than it holds, or for a bigger group than it is: no longer.
    expect(await titles("organization", { wideGroupShare: 0.9 })).toEqual([]);
    expect(await titles("organization", { wideGroupMin: 13 })).toEqual([]);
    expect((await titles("organization", { wideGroupShare: 0.3, wideGroupMin: 5 })).sort()).toEqual(
      ["narrow.txt", "wide.txt"],
    );

    // Sensitive and wide: by a trusted tag whose value sets a level, never a model's guess.
    await inTenant(async (tx) => {
      await tx.insert(facets).values({ tenantId: t.tenantId, key: "sensitivity", label: "S" });
      await tx.insert(facetValues).values(
        ["restricted", "internal"].map((value) => ({
          tenantId: t.tenantId,
          facet: "sensitivity",
          value,
          label: value,
          approved: true,
          ...(value === "restricted" ? { visibility: "hidden" as const } : {}),
        })),
      );
    });
    const tag = (objectId: string, value: string, source: "rule" | "model", reviewed = false) =>
      inTenant((tx) =>
        tx.insert(objectTags).values({
          tenantId: t.tenantId,
          objectId,
          facet: "sensitivity",
          value,
          source,
          appliedBy: source === "rule" ? "rule:x" : "model:x/y",
          confidence: 1,
          reviewed,
        }),
      );
    const guessed = await file("guessed.txt");
    const harmless = await file("harmless.txt");
    const linked = await file("linked.txt");
    for (const id of [guessed, harmless]) await grant(id, `group:${most}`);
    await share(linked, "link-anyone", "L9");
    await tag(wide, "restricted", "rule");
    await tag(guessed, "restricted", "model");
    await tag(harmless, "internal", "rule");
    await tag(linked, "restricted", "model", true);
    // A value that sets a level without restricting (it opens the file up) is not sensitive.
    await inTenant((tx) =>
      tx
        .update(facetValues)
        .set({ visibility: "readable", exposure: "full" })
        .where(eq(facetValues.value, "internal")),
    );
    const exposed = (await report()).sections.sensitiveWide.items;
    expect(exposed.map((i) => [i.title, i.detail]).sort()).toEqual([
      ["linked.txt", "sensitivity:restricted; link-anyone (read)"],
      ["wide.txt", "sensitivity:restricted; group Everyone (12 people, read)"],
    ]);

    // A grant on a tag reaches the files that carry it as a trusted tag, as authorize() reads
    // it: not one a model only guessed.
    await inTenant((tx) =>
      addGrant(tx, t.tenantId, {
        principal: `group:${most}`,
        role: "write",
        target: { tag: "sensitivity:internal" },
        grantedBy: "user:admin",
      }),
    );
    const tagged = await file("tagged.txt");
    const maybe = await file("maybe.txt");
    await tag(tagged, "internal", "rule");
    await tag(maybe, "internal", "model");
    const reached = (await report()).sections.organization.items;
    expect(reached.map((i) => i.title).sort()).toEqual([
      "guessed.txt",
      "harmless.txt",
      "tagged.txt",
      "wide.txt",
    ]);
    expect(reached.find((i) => i.title === "tagged.txt")?.detail).toBe(
      "group Everyone (12 people, write through sensitivity:internal)",
    );
  });

  it("lists files someone who left made, changed last, or can still be granted", async () => {
    const scim = (name: string) => person(name, { source: "scim", externalId: `aad-${name}` });
    const [locked, disabled, retired, here] = [
      await scim("lou"),
      await scim("dee"),
      await scim("rae"),
      await scim("hal"),
    ];
    await inTenant(async (tx) => {
      await lockUser(tx, t.tenantId, locked, "user:admin");
      await setProviderActive(tx, t.tenantId, disabled, false, "scim:tok");
    });
    const made = await file("made.txt", { createdBy: "aad-lou", modifiedBy: "aad-hal" });
    await file("changed.txt", { createdBy: "aad-hal", modifiedBy: "aad-dee" });
    await file("both.txt", { createdBy: "aad-rae", modifiedBy: "aad-rae" });
    await file("current.txt", { createdBy: "aad-hal", modifiedBy: "aad-hal" });
    // Someone the tenant never knew is not someone who left.
    await file("unknown.txt", { createdBy: "aad-stranger" });
    const held = await file("held.txt");
    await grant(held, `user:${locked}`);
    await grant(made, `user:${here}`);
    await inTenant((tx) => retireUser(tx, t.tenantId, retired, "scim:tok"));
    // Someone who left and was provisioned again, under the same id there, has not left.
    const back = await scim("bea");
    await inTenant((tx) => retireUser(tx, t.tenantId, back, "scim:tok"));
    await person("bea2", { source: "scim", externalId: "aad-bea" });
    await file("returned.txt", { createdBy: "aad-bea" });
    // A file here whose owner has left.
    const owned = await file("owned.txt", { createdBy: "aad-hal" });
    await inTenant((tx) =>
      tx
        .update(objects)
        .set({ ownerId: `user:${locked}` })
        .where(eq(objects.id, owned)),
    );
    // What the account that was retired owns, the one provisioned after it did not inherit.
    const kept = await file("kept.txt", { createdBy: "aad-hal" });
    await inTenant((tx) =>
      tx
        .update(objects)
        .set({ ownerId: `user:${back}` })
        .where(eq(objects.id, kept)),
    );
    // Still in a group: counted as a person to take out of it, not file by file.
    await inTenant(async (tx) => {
      const g = await createGroup(tx, t.tenantId, { name: "Old team", source: "scim" });
      await addMember(tx, t.tenantId, g.id, disabled, "scim");
      await addGrant(tx, t.tenantId, {
        principal: `group:${g.id}`,
        role: "read",
        target: { objectId: owned },
        grantedBy: "user:admin",
      });
    });

    const got = await report();
    expect(got.sections.formerStaff.items.map((i) => [i.title, i.detail]).sort()).toEqual([
      ["both.txt", "made by rae; last changed by rae"],
      ["changed.txt", "last changed by dee"],
      ["held.txt", "still granted to lou (read)"],
      ["kept.txt", "owned by bea"],
      ["made.txt", "made by lou"],
      ["owned.txt", "owned by lou"],
    ]);
    expect(got.formerStaffInGroups).toBe(1);
    expect(got.unattributed).toBe(1); // held.txt: the source named nobody
    expect(got.unknownPeople).toBe(1); // unknown.txt
  });

  it("lists stale, duplicated and large files, worst first, and what they waste", async () => {
    const day = 86_400_000;
    const asOf = new Date("2026-06-01T00:00:00Z");
    await file("ancient.txt", { modifiedAt: new Date(asOf.getTime() - 3000 * day) });
    await file("old.txt", { modifiedAt: new Date(asOf.getTime() - 1100 * day) });
    await file("recent.txt", { modifiedAt: new Date(asOf.getTime() - 1090 * day) });
    await file("undated.txt", { unsynced: true });
    expect(await titles("stale", { asOf })).toEqual(["ancient.txt", "old.txt"]);
    expect(await titles("stale", { asOf, staleAfterDays: 30 })).toEqual([
      "ancient.txt",
      "old.txt",
      "recent.txt",
    ]);
    expect((await report({ asOf })).undated).toBe(1);

    // Three copies of one content, two of another, and empty files, which are no one's copies.
    for (const name of ["a1", "a2", "a3"]) await file(name, { content: 101, bytes: 500 });
    for (const name of ["b1", "b2"]) await file(name, { content: 102, bytes: 2000 });
    for (const name of ["e1", "e2"]) await file(name, { content: 103, bytes: 0 });
    const deleted = await file("b3", { content: 102, bytes: 2000 });
    await inTenant((tx) =>
      tx
        .update(objects)
        .set({ deletedAt: sql`now()` })
        .where(eq(objects.id, deleted)),
    );
    const got = await report({ asOf, largeBytes: 499 });
    expect(got.sections.duplicates).toMatchObject({ count: 5, bytes: 2000 + 2 * 500 });
    expect(got.sections.duplicates.items.map((i) => [i.title, i.detail])).toEqual(
      expect.arrayContaining([
        ["a1", "same content as 2 other files"],
        ["b2", "same content as 1 other file"],
      ]),
    );
    expect(got.sections.duplicates.items.slice(0, 2).map((i) => i.bytes)).toEqual([2000, 2000]);
    expect(got.sections.large).toMatchObject({ count: 5, bytes: 2 * 2000 + 3 * 500 });
    expect(got.sections.large.items[0]?.detail).toMatch(/^2000 bytes$/);
    // The count is of all, the list of the first few.
    const few = await report({ asOf, largeBytes: 499, limit: 2 });
    expect(few.sections.large).toMatchObject({ count: 5 });
    expect(few.sections.large.items).toHaveLength(2);
    // A newer version is the file's content: the older one counts for nothing.
    const [a1] = await inTenant((tx) =>
      tx.select({ id: objects.id }).from(objects).where(eq(objects.title, "a1")),
    );
    await inTenant(async (tx) => {
      const blobId = `b3t:${"f".repeat(64)}`;
      await tx.insert(blobs).values({ tenantId: t.tenantId, id: blobId, size: 7 });
      await tx.insert(versions).values({
        tenantId: t.tenantId,
        id: newId("version"),
        objectId: a1?.id as string,
        seq: 2,
        blobId,
        mime: "text/plain",
      });
    });
    expect((await report({ asOf })).sections.duplicates).toMatchObject({
      count: 4,
      bytes: 2000 + 500,
    });
  });
});
