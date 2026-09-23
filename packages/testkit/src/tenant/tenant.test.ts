import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AccessModel,
  apportion,
  contentBytes,
  contentStream,
  EVERYONE_GROUP_ID,
  generateTenant,
  HUGE_FILE_BYTES,
  MAX_BUFFERED_BYTES,
  type FakeTenant,
  type ProblemKind,
} from "../index.js";

let tenant: FakeTenant;
let access: AccessModel;
beforeAll(() => {
  tenant = generateTenant();
  access = new AccessModel(tenant);
});

/** Compares large byte arrays quickly (deep equality on multi-MB arrays is very slow). */
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

const fingerprint = (t: FakeTenant) => createHash("sha256").update(JSON.stringify(t)).digest("hex");

describe("generateTenant", () => {
  it("builds exactly the requested number of items", () => {
    expect(tenant.items).toHaveLength(10_000);
    expect(generateTenant({ items: 250 }).items).toHaveLength(250);
    expect(generateTenant({ items: 1 }).items).toHaveLength(1);
  });

  it("is deterministic for a seed and differs across seeds", () => {
    const again = generateTenant({ items: 2000 });
    expect(generateTenant({ items: 2000 })).toEqual(again);
    expect(fingerprint(generateTenant({ items: 2000, seed: "other" }))).not.toBe(
      fingerprint(again),
    );
  });

  it("produces the same tenant on every platform and Node version", () => {
    // Pinned on purpose. If this changes, the generator changed: every stored seed in bug
    // reports and fixtures now means something else, so bump this only for a deliberate change.
    expect(fingerprint(generateTenant({ items: 2000 }))).toBe(
      "f8bb06506681bdfe669dcdd2b190f27adadbae007b58bf33e26b76af8bbedb36",
    );
  });

  it("rejects bad options", () => {
    expect(() => generateTenant({ items: 0 })).toThrow(RangeError);
    expect(() => generateTenant({ items: 1.5 })).toThrow(RangeError);
    expect(() => generateTenant({ now: "not a date" })).toThrow(RangeError);
    expect(() => generateTenant({ domain: "real-company.com" })).toThrow(/reserved TLD/);
  });

  it("gives every item a unique id and a unique path within its drive", () => {
    expect(new Set(tenant.items.map((i) => i.id)).size).toBe(tenant.items.length);
    const paths = tenant.items.map((i) => `${i.driveId}${i.path.toLowerCase()}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps the folder tree consistent", () => {
    const byId = new Map(tenant.items.map((i) => [i.id, i]));
    for (const item of tenant.items) {
      const parent = item.parentId ? byId.get(item.parentId) : undefined;
      if (item.parentId) {
        expect(parent?.kind).toBe("folder");
        expect(parent?.driveId).toBe(item.driveId);
      }
      expect(item.path).toBe(`${parent?.path ?? ""}/${item.name}`);
      expect(Date.parse(item.modifiedAt)).toBeGreaterThanOrEqual(Date.parse(item.createdAt));
      expect(Date.parse(item.modifiedAt)).toBeLessThanOrEqual(Date.parse(tenant.now));
    }
  });

  it("only uses reserved domains for people", () => {
    for (const u of tenant.users) expect(u.upn).toMatch(/@[a-z.]+\.(test|example)$/);
    expect(new Set(tenant.users.map((u) => u.upn)).size).toBe(tenant.users.length);
  });

  it("inherits permissions from the parent unless inheritance is broken", () => {
    const byId = new Map(tenant.items.map((i) => [i.id, i]));
    for (const item of tenant.items) {
      expect(item.acl.length).toBeGreaterThan(0);
      for (const entry of item.acl) expect(entry.externalId).toBe(item.id);
      const inherited = item.acl.filter((a) => a.inherited).map((a) => `${a.principal}/${a.role}`);
      if (inherited.length === 0 || !item.parentId) continue;
      const parent = byId.get(item.parentId);
      const parentShared = (parent?.acl ?? [])
        .filter((a) => a.principal !== "anyone-with-link" && !a.principal.startsWith("guest:"))
        .map((a) => `${a.principal}/${a.role}`);
      expect(inherited).toEqual(parentShared);
    }
  });

  it("plants canary tokens only on files that Everyone cannot read", () => {
    const canaries = tenant.items.filter((i) => i.canary);
    expect(canaries.length).toBeGreaterThan(20);
    for (const item of canaries) {
      expect(item.kind).toBe("file");
      expect(item.name).toContain(item.canary);
      expect(item.acl.some((a) => a.principal === `group:${EVERYONE_GROUP_ID}`)).toBe(false);
    }
  });
});

describe("seeded problems", () => {
  const every: ProblemKind[] = [
    "anyone-link",
    "external-guest",
    "orphaned-owner",
    "duplicate",
    "stale",
    "broken-inheritance",
    "sensitive-in-open-site",
    "injection-filename",
    "huge-file",
    "long-path",
  ];

  it("includes at least one of every kind in the default tenant", () => {
    const kinds = new Set(tenant.problems.map((p) => p.kind));
    for (const kind of every) expect(kinds, kind).toContain(kind);
  });

  it("lists duplicates whose content really is identical", async () => {
    const dupes = tenant.problems.filter((p) => p.kind === "duplicate");
    const byId = new Map(tenant.items.map((i) => [i.id, i]));
    const groups = new Map<string, string[]>();
    for (const p of dupes) {
      const item = byId.get(p.itemId);
      if (!item) throw new Error("unknown item");
      groups.set(item.contentKey, [...(groups.get(item.contentKey) ?? []), item.id]);
    }
    const [key, ids] = [...groups].find(([, v]) => v.length >= 2) ?? [];
    expect(key).toBeDefined();
    const [a, b] = (ids ?? []).map((id) => byId.get(id));
    if (!a || !b) throw new Error("duplicate group too small");
    expect(sameBytes(await contentBytes(tenant, a), await contentBytes(tenant, b))).toBe(true);
  });

  it("keeps every planted injection file name intact", () => {
    const names = tenant.problems
      .filter((p) => p.kind === "injection-filename")
      .map((p) => tenant.items.find((i) => i.id === p.itemId)?.name);
    expect(names).toHaveLength(4);
    expect(names.some((n) => n?.includes("\u202e"))).toBe(true);
  });
});

describe("content", () => {
  it("streams exactly the declared size, with the canary in the header", async () => {
    const item = tenant.items.find((i) => i.canary && i.size < 200_000);
    if (!item) throw new Error("no small canary file");
    const bytes = await contentBytes(tenant, item);
    expect(bytes.byteLength).toBe(item.size);
    const text = new TextDecoder().decode(bytes.subarray(0, 300));
    expect(text).toContain(item.canary);
    for (const label of item.labels) expect(text).toContain(label);
  });

  it("is deterministic and differs between files", async () => {
    const [a, b] = tenant.items.filter((i) => i.kind === "file" && i.contentKey === i.id);
    if (!a || !b) throw new Error("need two files");
    expect(sameBytes(await contentBytes(tenant, a), await contentBytes(generateTenant(), a))).toBe(
      true,
    );
    const head = async (i: typeof a) => (await contentBytes(tenant, i)).subarray(0, 1000);
    expect(sameBytes(await head(a), await head(b))).toBe(false);
  });

  it("streams huge files lazily and refuses to buffer them", async () => {
    const huge = tenant.items.find((i) => i.size > HUGE_FILE_BYTES);
    if (!huge) throw new Error("no huge file");
    await expect(contentBytes(tenant, huge)).rejects.toThrow(/use contentStream/);
    const reader = contentStream(tenant, huge).getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    await reader.cancel();
  });

  it("refuses folders", () => {
    const folder = tenant.items.find((i) => i.kind === "folder");
    if (!folder) throw new Error("no folder");
    expect(() => contentStream(tenant, folder)).toThrow(TypeError);
  });
});

describe("AccessModel", () => {
  it("never grants access through an anyone-with-link entry alone", () => {
    const linkOnly = {
      ...(tenant.items[0] as FakeTenant["items"][number]),
      acl: [
        { externalId: "x", principal: "anyone-with-link", role: "read" as const, inherited: false },
      ],
    };
    expect(new AccessModel(tenant).readersOf(linkOnly).size).toBe(0);
  });

  it("excludes people who have left", () => {
    const departed = tenant.users.find((u) => !u.active);
    if (!departed) throw new Error("no departed user");
    expect(access.readableBy(departed.id)).toHaveLength(0);
  });

  it("lets guests read their client's project site and nothing internal", () => {
    const guest = tenant.users.find((u) => u.guest);
    if (!guest) throw new Error("no guest");
    const readable = access.readableBy(guest.id);
    expect(readable.length).toBeGreaterThan(0);
    const sites = new Set(readable.map((i) => i.siteId));
    for (const siteId of sites) {
      const direct = readable.filter((i) => i.siteId === siteId);
      const viaShare = direct.every((i) => i.acl.some((a) => a.principal === `guest:${guest.upn}`));
      expect(siteId.startsWith("s-project-") || viaShare).toBe(true);
    }
    expect(access.principalsOf(guest.id)).toContain(`guest:${guest.upn}`);
  });

  it("keeps restricted department sites to their department", () => {
    const hr = tenant.items.filter((i) => i.siteId === "s-hr" && i.acl.every((a) => a.inherited));
    const outsider = tenant.users.find((u) => u.active && !u.guest && u.department !== "HR");
    if (!outsider || hr.length === 0) throw new Error("fixture missing");
    for (const item of hr) expect(access.canRead(outsider.id, item)).toBe(false);
  });

  it("rejects unknown users", () => {
    expect(() => access.principalsOf("nobody")).toThrow(RangeError);
  });
});

describe("apportion", () => {
  it("splits a total exactly and proportionally", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(7, [2, 1])).toEqual([5, 2]);
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
  });
});
