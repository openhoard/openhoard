import { Random } from "../random.js";
import type {
  FakeAclEntry,
  FakeGroup,
  FakeItem,
  FakeSite,
  FakeTenant,
  FakeUser,
  ProblemKind,
  SeededProblem,
} from "./types.js";
import {
  CLIENTS,
  DEPARTMENTS,
  DOC_TYPES,
  FIRST_NAMES,
  FOLDER_NAMES,
  INJECTION_NAMES,
  LAST_NAMES,
  MIME_BY_EXT,
  QUALIFIERS,
  RESTRICTED_DEPARTMENTS,
  type DocType,
} from "./vocabulary.js";

export interface TenantOptions {
  /** Same seed, same options → identical tenant on every machine. Default `"openhoard"`. */
  seed?: string;
  /** Total files and folders to generate. Default 10,000. */
  items?: number;
  /** The tenant's "now" (ISO 8601). All dates fall before it. Default 2026-09-01. */
  now?: string;
  /** Email domain for internal users. Must be a reserved TLD. Default `hoard.test`. */
  domain?: string;
}

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const GIB = 1024 ** 3;
/** Files not modified for this long count as stale. */
export const STALE_AFTER_MS = 3 * YEAR_MS;
/** Paths longer than this exceed SharePoint's 400-character limit. */
export const MAX_PATH_LENGTH = 400;
/** Files larger than this count as huge. */
export const HUGE_FILE_BYTES = GIB;
export const EVERYONE_GROUP_ID = "g-everyone";

/**
 * Generates a deterministic fake tenant: users, groups, sites, a folder tree, files with
 * realistic names, sizes, dates and permissions, and a known set of planted problems.
 *
 * Nothing touches the network or the clock: the same options always produce the same tenant,
 * so a failing test can be reproduced from its seed.
 */
export function generateTenant(options: TenantOptions = {}): FakeTenant {
  const seed = options.seed ?? "openhoard";
  const itemBudget = options.items ?? 10_000;
  const now = Date.parse(options.now ?? "2026-09-01T00:00:00.000Z");
  const domain = options.domain ?? "hoard.test";
  if (!Number.isInteger(itemBudget) || itemBudget < 1) {
    throw new RangeError("items must be a positive integer");
  }
  if (Number.isNaN(now)) throw new RangeError("now must be an ISO 8601 date");
  if (!/\.(test|example|invalid|localhost)$/.test(domain)) {
    throw new RangeError("domain must use a reserved TLD so fake data never reaches real mail");
  }

  const rng = new Random(seed);
  const people = makeUsers(rng.fork("users"), itemBudget, domain);
  const groups = makeGroups(rng.fork("groups"), people);
  const sites = makeSites(domain, groups);
  const builder = new ItemBuilder(rng.fork("items"), now, people, groups, sites);
  builder.build(itemBudget);

  const tenant: FakeTenant = {
    id: `t-${seed}`,
    seed,
    domain,
    now: new Date(now).toISOString(),
    users: people.users,
    groups,
    sites,
    items: builder.items,
    problems: [],
  };
  tenant.problems = listProblems(tenant);
  return tenant;
}

// ── People ───────────────────────────────────────────────────────────────────────────────

interface People {
  users: FakeUser[];
  /** Guest user ids per client key. */
  guestsByClient: Map<string, string[]>;
}

function makeUsers(rng: Random, itemBudget: number, domain: string): People {
  const total = Math.min(5000, Math.max(24, Math.round(itemBudget / 50)));
  const guestCount = Math.max(CLIENTS.length, Math.round(total * 0.05));
  const users: FakeUser[] = [];
  const taken = new Set<string>();
  const guestsByClient = new Map<string, string[]>(CLIENTS.map((c) => [c.key, []]));

  const uniqueUpn = (local: string, host: string) => {
    let upn = `${local}@${host}`;
    for (let n = 2; taken.has(upn); n++) upn = `${local}${n}@${host}`;
    taken.add(upn);
    return upn;
  };
  const person = () => {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    return { first, last, local: `${first}.${last}`.toLowerCase() };
  };

  for (let i = 0; i < total - guestCount; i++) {
    const p = person();
    users.push({
      id: `u-${pad(users.length + 1)}`,
      upn: uniqueUpn(p.local, domain),
      displayName: `${p.first} ${p.last}`,
      department: rng.weighted(DEPARTMENTS.map((d) => [d, d === "Engineering" ? 3 : 1] as const)),
      guest: false,
      // The first few users are always active, so every tenant has usable accounts.
      active: i < 5 || !rng.chance(0.06),
    });
  }
  for (let i = 0; i < guestCount; i++) {
    const client = CLIENTS[i % CLIENTS.length] as (typeof CLIENTS)[number];
    const p = person();
    const id = `u-${pad(users.length + 1)}`;
    users.push({
      id,
      upn: uniqueUpn(p.local, client.domain),
      displayName: `${p.first} ${p.last} (${client.name})`,
      department: "External",
      guest: true,
      active: true,
    });
    guestsByClient.get(client.key)?.push(id);
  }
  return { users, guestsByClient };
}

function makeGroups(rng: Random, people: People): FakeGroup[] {
  const internal = people.users.filter((u) => !u.guest);
  const groups: FakeGroup[] = [
    { id: EVERYONE_GROUP_ID, displayName: "Everyone", members: internal.map((u) => u.id) },
    {
      id: "g-leadership",
      displayName: "Leadership",
      members: rng
        .sample(internal, Math.max(2, Math.round(internal.length * 0.05)))
        .map((u) => u.id)
        .sort(),
    },
  ];
  for (const dept of DEPARTMENTS) {
    groups.push({
      id: `g-${dept.toLowerCase()}`,
      displayName: `${dept} Team`,
      members: internal.filter((u) => u.department === dept).map((u) => u.id),
    });
  }
  for (const client of CLIENTS) {
    const staff = rng.sample(internal, Math.max(2, Math.round(internal.length * 0.06)));
    groups.push({
      id: `g-project-${client.key}`,
      displayName: `Project ${client.name}`,
      members: [...staff.map((u) => u.id), ...(people.guestsByClient.get(client.key) ?? [])].sort(),
    });
  }
  return groups;
}

function makeSites(domain: string, groups: FakeGroup[]): FakeSite[] {
  const host = `${domain.split(".")[0] ?? "tenant"}.sharepoint.test`;
  const site = (name: string, displayName: string, readers: string[], writers: string[]) => ({
    id: `s-${name}`,
    name,
    displayName,
    webUrl: `https://${host}/sites/${name}`,
    readerGroups: readers,
    writerGroups: writers,
    driveId: `d-${name}`,
  });
  const known = new Set(groups.map((g) => g.id));
  const sites: FakeSite[] = [
    site("all-company", "All Company", [EVERYONE_GROUP_ID], ["g-leadership"]),
  ];
  for (const dept of DEPARTMENTS) {
    const g = `g-${dept.toLowerCase()}`;
    const readers = RESTRICTED_DEPARTMENTS.has(dept) ? [g] : [EVERYONE_GROUP_ID];
    sites.push(site(dept.toLowerCase(), dept, readers, [g]));
  }
  for (const client of CLIENTS) {
    const g = `g-project-${client.key}`;
    sites.push(site(`project-${client.key}`, `Project ${client.name}`, [g], [g]));
  }
  for (const s of sites) {
    for (const g of [...s.readerGroups, ...s.writerGroups]) {
      /* v8 ignore next -- guards against editing the site table without the groups */
      if (!known.has(g)) throw new Error(`site ${s.id} references unknown group ${g}`);
    }
  }
  return sites;
}

// ── Items ────────────────────────────────────────────────────────────────────────────────

class ItemBuilder {
  readonly items: FakeItem[] = [];
  private readonly byId = new Map<string, FakeItem>();
  private readonly namesInFolder = new Map<string, Set<string>>();
  private readonly users: Map<string, FakeUser>;
  private readonly groups: Map<string, FakeGroup>;
  private injectionNamesLeft: string[];
  private readonly guests: FakeUser[];
  private readonly canaries = new Set<string>();

  constructor(
    private readonly rng: Random,
    private readonly now: number,
    private readonly people: People,
    groups: FakeGroup[],
    private readonly sites: FakeSite[],
  ) {
    this.users = new Map(people.users.map((u) => [u.id, u]));
    this.groups = new Map(groups.map((g) => [g.id, g]));
    this.injectionNamesLeft = [...INJECTION_NAMES];
    this.guests = people.users.filter((u) => u.guest);
  }

  build(budget: number): void {
    const weights = this.sites.map((s) =>
      s.name === "all-company" ? 2 : s.name.startsWith("project-") ? 1.5 : 2,
    );
    const shares = apportion(budget, weights);
    this.sites.forEach((site, i) => this.buildSite(site, shares[i] ?? 0));
  }

  private buildSite(site: FakeSite, budget: number): void {
    if (budget === 0) return;
    const rng = this.rng.fork(site.id);
    const rootAcl = siteAcl(site);
    const folders: FakeItem[] = [];
    let remaining = budget;

    // One deep chain in Engineering exceeds SharePoint's path limit (a "long-path" problem).
    if (site.name === "engineering" && remaining >= 12) {
      let parent: FakeItem | undefined;
      for (let depth = 0; depth < 8; depth++) {
        parent = this.addFolder(
          rng,
          site,
          parent,
          rootAcl,
          `Project archive level ${depth + 1} - migrated from legacy file share`,
        );
        folders.push(parent);
        remaining--;
      }
      this.addFile(rng, site, parent, rootAcl, {
        forceName: "Legacy migration checklist - keep until audit sign-off.docx",
      });
      remaining--;
    }

    const folderCount = Math.min(remaining, Math.round(remaining * 0.1));
    for (let i = 0; i < folderCount; i++) {
      const candidates = folders.filter((f) => depthOf(f) < 4);
      const parent =
        folders.length && rng.chance(0.7)
          ? rng.pick(candidates.length ? candidates : folders)
          : undefined;
      folders.push(this.addFolder(rng, site, parent, rootAcl, rng.pick(FOLDER_NAMES)));
      remaining--;
    }
    for (let i = 0; i < remaining; i++) {
      const parent = folders.length && rng.chance(0.8) ? rng.pick(folders) : undefined;
      this.addFile(rng, site, parent, rootAcl, {});
    }
  }

  private addFolder(
    rng: Random,
    site: FakeSite,
    parent: FakeItem | undefined,
    rootAcl: FakeAclEntry[],
    base: string,
  ): FakeItem {
    const item = this.newItem(rng, site, parent, "folder", base);
    item.acl = rng.chance(0.03)
      ? this.uniqueAcl(rng, site, item)
      : inheritAcl(parent?.acl ?? rootAcl, item.id);
    return item;
  }

  private addFile(
    rng: Random,
    site: FakeSite,
    parent: FakeItem | undefined,
    rootAcl: FakeAclEntry[],
    opts: { forceName?: string },
  ): FakeItem {
    const type = rng.pick(DOC_TYPES);
    const ext = rng.pick(type.exts);
    const clientKey = site.name.startsWith("project-")
      ? site.name.slice("project-".length)
      : rng.chance(0.2)
        ? rng.pick(CLIENTS).key
        : undefined;

    let name = opts.forceName ?? fileName(rng, type, ext, clientKey);
    const injection = !opts.forceName && this.injectionNamesLeft.length > 0 && rng.chance(0.002);
    if (injection) name = this.injectionNamesLeft.shift() as string;

    const item = this.newItem(rng, site, parent, "file", name);
    item.mime = MIME_BY_EXT[extOf(item.name)] ?? "application/octet-stream";
    item.size = rng.int(type.size[0], type.size[1]);
    item.labels = labelsFor(rng, site, type, clientKey);

    item.acl = rng.chance(0.02)
      ? this.uniqueAcl(rng, site, item)
      : inheritAcl(parent?.acl ?? rootAcl, item.id);
    if (rng.chance(0.015)) {
      item.acl.push({
        externalId: item.id,
        principal: "anyone-with-link",
        role: "read",
        inherited: false,
        ...(rng.chance(0.5)
          ? { expiresAt: new Date(this.now + rng.int(1, 90) * DAY_MS).toISOString() }
          : {}),
      });
    }
    if (!site.name.startsWith("project-") && rng.chance(0.01)) {
      item.acl.push({
        externalId: item.id,
        principal: `guest:${rng.pick(this.guests).upn}`,
        role: "read",
        inherited: false,
      });
    }

    // Planted names (injection, long path) must survive, so they never get content variants.
    const planted = injection || opts.forceName !== undefined;
    if (!planted) this.plantContentVariants(rng, item);
    const original = item.contentKey === item.id && item.size <= HUGE_FILE_BYTES;
    if (!planted && original && this.isRestricted(item) && rng.chance(0.03)) {
      item.canary = this.uniqueCanary(rng);
      const at = item.name.lastIndexOf(".");
      this.rename(item, `${item.name.slice(0, at)} ${item.canary}${item.name.slice(at)}`);
    }
    return item;
  }

  /** Huge files and duplicates. Duplicates copy an earlier file's bytes exactly. */
  private plantContentVariants(rng: Random, item: FakeItem): void {
    if (rng.chance(0.0005)) {
      item.size = rng.int(Math.round(1.5 * GIB), 4 * GIB);
      item.mime = MIME_BY_EXT.csv as string;
      this.rename(item, `${item.name.slice(0, item.name.lastIndexOf("."))} full export.csv`);
      return;
    }
    if (rng.chance(0.02)) {
      const candidates = this.items.filter(
        (o) =>
          o.kind === "file" &&
          o.id !== item.id &&
          o.canary === undefined &&
          o.size < HUGE_FILE_BYTES,
      );
      if (candidates.length === 0) return;
      const origin = rng.pick(candidates);
      item.contentKey = origin.contentKey;
      item.size = origin.size;
      item.mime = origin.mime;
      this.rename(item, rng.chance(0.5) ? `Copy of ${origin.name}` : origin.name);
    }
  }

  private newItem(
    rng: Random,
    site: FakeSite,
    parent: FakeItem | undefined,
    kind: FakeItem["kind"],
    name: string,
  ): FakeItem {
    const id = `i-${pad(this.items.length + 1, 6)}`;
    const created = this.now - rng.int(1, 6 * 365) * DAY_MS - rng.int(0, DAY_MS - 1);
    // Skewed towards early edits: most files are touched soon after creation, then left alone.
    // (x * x rather than x ** 2: multiplication is exact IEEE 754 everywhere, pow need not be.)
    const skew = rng.next();
    const modified = created + Math.floor((this.now - created) * skew * skew);
    const writers = site.writerGroups.flatMap((g) => this.groups.get(g)?.members ?? []);
    const creator = writers.length ? rng.pick(writers) : (this.people.users[0] as FakeUser).id;
    const activeWriters = writers.filter((w) => this.users.get(w)?.active);
    const item: FakeItem = {
      id,
      siteId: site.id,
      driveId: site.driveId,
      parentId: parent?.id,
      kind,
      name: "",
      path: "",
      mime: kind === "folder" ? "inode/directory" : "application/octet-stream",
      size: 0,
      createdAt: new Date(created).toISOString(),
      modifiedAt: new Date(modified).toISOString(),
      createdBy: creator,
      modifiedBy: activeWriters.length ? rng.pick(activeWriters) : creator,
      etag: `"{${id}},1"`,
      contentKey: id,
      labels: [],
      acl: [],
    };
    this.items.push(item);
    this.byId.set(id, item);
    this.rename(item, name);
    return item;
  }

  /** Sets a name that is unique within the parent folder, and the matching path. */
  private rename(item: FakeItem, wanted: string): void {
    const folderKey = `${item.driveId}/${item.parentId ?? ""}`;
    const names = this.namesInFolder.get(folderKey) ?? new Set<string>();
    this.namesInFolder.set(folderKey, names);
    names.delete(item.name.toLowerCase());
    const dot = item.kind === "file" ? wanted.lastIndexOf(".") : -1;
    const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    let name = wanted;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    names.add(name.toLowerCase());
    item.name = name;
    const parent = item.parentId ? this.byId.get(item.parentId) : undefined;
    item.path = `${parent?.path ?? ""}/${name}`;
  }

  /** Breaks inheritance: a few named people from the site, plus the creator as owner. */
  private uniqueAcl(rng: Random, site: FakeSite, item: FakeItem): FakeAclEntry[] {
    const readers = site.readerGroups.flatMap((g) => this.groups.get(g)?.members ?? []);
    const chosen = rng.sample(
      readers.filter((u) => u !== item.createdBy),
      rng.int(1, 4),
    );
    return [
      { externalId: item.id, principal: `user:${item.createdBy}`, role: "owner", inherited: false },
      ...chosen.sort().map((u): FakeAclEntry => ({
        externalId: item.id,
        principal: `user:${u}`,
        role: rng.chance(0.3) ? "write" : "read",
        inherited: false,
      })),
    ];
  }

  /** Canary tokens must be unique: each one has to point at exactly one file. */
  private uniqueCanary(rng: Random): string {
    let token: string;
    do token = `canary-${hex(rng, 8)}`;
    while (this.canaries.has(token));
    this.canaries.add(token);
    return token;
  }

  private isRestricted(item: FakeItem): boolean {
    return !item.acl.some((a) => a.principal === `group:${EVERYONE_GROUP_ID}`);
  }
}

/** The entries every item in a site inherits unless it breaks inheritance. */
export function siteAcl(site: FakeSite): FakeAclEntry[] {
  const writers = new Set(site.writerGroups);
  return [
    ...site.writerGroups.map((g): FakeAclEntry => ({
      externalId: site.id,
      principal: `group:${g}`,
      role: "write",
      inherited: true,
    })),
    ...site.readerGroups
      .filter((g) => !writers.has(g))
      .map((g): FakeAclEntry => ({
        externalId: site.id,
        principal: `group:${g}`,
        role: "read",
        inherited: true,
      })),
  ];
}

/** Copies a parent's entries onto a child. Explicit shares (links, guests) do not propagate. */
export function inheritAcl(parentAcl: readonly FakeAclEntry[], itemId: string): FakeAclEntry[] {
  return parentAcl
    .filter((a) => a.principal !== "anyone-with-link" && !a.principal.startsWith("guest:"))
    .map((a) => ({ externalId: itemId, principal: a.principal, role: a.role, inherited: true }));
}

function fileName(rng: Random, type: DocType, ext: string, clientKey: string | undefined): string {
  const client = clientKey ? CLIENTS.find((c) => c.key === clientKey)?.name : undefined;
  const parts = [client, rng.pick(type.words), rng.chance(0.7) ? rng.pick(QUALIFIERS) : undefined];
  return `${parts.filter(Boolean).join(" ")}.${ext}`;
}

function labelsFor(
  rng: Random,
  site: FakeSite,
  type: DocType,
  clientKey: string | undefined,
): string[] {
  const restricted = site.readerGroups.every((g) => g !== EVERYONE_GROUP_ID);
  const sensitivity = restricted
    ? rng.weighted([
        ["internal", 25],
        ["confidential", 60],
        ["restricted", 15],
      ] as const)
    : rng.weighted([
        ["public", 15],
        ["internal", 81.5],
        ["confidential", 3],
        ["restricted", 0.5],
      ] as const);
  const labels = [`type:${type.key}`, `sensitivity:${sensitivity}`];
  if (clientKey) labels.push(`client:${clientKey}`);
  if (!site.name.startsWith("project-") && site.name !== "all-company")
    labels.push(`department:${site.name}`);
  return labels.sort();
}

// ── Problems (ground truth) ──────────────────────────────────────────────────────────────

/**
 * Every problem in the tenant, by definition. Computed after generation, so the list is
 * complete: a correct detector finds exactly these, no more and no fewer.
 */
export function listProblems(tenant: FakeTenant): SeededProblem[] {
  const now = Date.parse(tenant.now);
  const users = new Map(tenant.users.map((u) => [u.id, u]));
  const openSites = new Set(
    tenant.sites.filter((s) => s.readerGroups.includes(EVERYONE_GROUP_ID)).map((s) => s.id),
  );
  const byContent = new Map<string, FakeItem[]>();
  const out: SeededProblem[] = [];
  const add = (kind: ProblemKind, item: FakeItem, detail: string) =>
    out.push({ kind, itemId: item.id, detail });

  for (const item of tenant.items) {
    if (item.acl.length > 0 && item.acl.every((a) => !a.inherited))
      add("broken-inheritance", item, `${item.acl.length} unique entries`);
    if (item.path.length > MAX_PATH_LENGTH)
      add("long-path", item, `${item.path.length} characters`);
    if (item.kind !== "file") continue;
    (
      byContent.get(item.contentKey) ?? byContent.set(item.contentKey, []).get(item.contentKey)
    )?.push(item);
    for (const a of item.acl) {
      if (a.principal === "anyone-with-link")
        add("anyone-link", item, a.expiresAt ? `expires ${a.expiresAt}` : "no expiry");
      if (a.principal.startsWith("guest:"))
        add("external-guest", item, a.principal.slice("guest:".length));
    }
    if (users.get(item.createdBy)?.active === false) add("orphaned-owner", item, item.createdBy);
    if (now - Date.parse(item.modifiedAt) > STALE_AFTER_MS)
      add("stale", item, `last modified ${item.modifiedAt}`);
    const sensitive =
      item.labels.includes("sensitivity:confidential") ||
      item.labels.includes("sensitivity:restricted");
    if (
      sensitive &&
      openSites.has(item.siteId) &&
      item.acl.some((a) => a.principal === `group:${EVERYONE_GROUP_ID}`)
    ) {
      add("sensitive-in-open-site", item, "readable by Everyone");
    }
    if (INJECTION_NAMES.some((n) => item.name === n))
      add("injection-filename", item, "instructions in the file name");
    if (item.size > HUGE_FILE_BYTES) add("huge-file", item, `${item.size} bytes`);
  }
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    for (const item of group)
      add("duplicate", item, `same content as ${group.length - 1} other file(s)`);
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

/** Splits `total` into integer shares proportional to `weights` (largest remainder method). */
export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (total * w) / sum);
  const shares = exact.map(Math.floor);
  const order = exact
    .map((e, i) => [e - Math.floor(e), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const leftover = total - shares.reduce((a, b) => a + b, 0);
  for (let k = 0; k < leftover; k++) {
    const i = (order[k] as readonly [number, number])[1];
    shares[i] = (shares[i] ?? 0) + 1;
  }
  return shares;
}

function depthOf(item: FakeItem): number {
  return item.path.split("/").length - 2;
}

function extOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

function hex(rng: Random, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += rng.int(0, 15).toString(16);
  return s;
}
