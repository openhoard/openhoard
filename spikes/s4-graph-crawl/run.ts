// Spike S4 (T-023): how fast can a connector crawl SharePoint/OneDrive through Microsoft Graph,
// follow changes with delta, and import permissions? Pass: 100k items < 2 h, delta lag < 5 min,
// ACLs correct.
//
// Offline, against the testkit's fake Graph (validates the crawler and gives a lower bound):
//   pnpm --filter @openhoard/spike-s4-graph-crawl spike -- --fake --items 20000
// Against a Microsoft 365 developer tenant (the real test):
//   GRAPH_TOKEN=<app-only token with Sites.Read.All> pnpm --filter @openhoard/spike-s4-graph-crawl spike
//
// Throwaway code: see docs/spikes/s4-graph-crawl.md for the write-up and the run book.
import { parseArgs } from "node:util";
import { AccessModel, FakeGraph, generateTenant, type FakeTenant } from "@openhoard/testkit";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    fake: { type: "boolean", default: false },
    items: { type: "string", default: "20000" },
    concurrency: { type: "string", default: "8" },
    changes: { type: "string", default: "50" },
    // Simulated network round trip for the fake, so its numbers mean something (ms).
    latency: { type: "string", default: "40" },
  },
});
const concurrency = Number(values.concurrency);

interface Page<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}
interface DriveItem {
  id: string;
  name: string;
  file?: unknown;
  folder?: unknown;
  root?: unknown;
  deleted?: unknown;
  parentReference?: { driveId?: string };
}
interface Permission {
  roles: string[];
  inheritedFrom?: unknown;
  link?: { scope: string };
  grantedToV2?: { user?: { id: string; email?: string }; group?: { id: string } };
  invitation?: { email: string };
}

let fake: FakeGraph | undefined;
let tenant: FakeTenant | undefined;
let base = "https://graph.microsoft.com";
const token = process.env.GRAPH_TOKEN ?? "fake-graph-token";
if (values.fake) {
  tenant = generateTenant({ items: Number(values.items) });
  fake = new FakeGraph(tenant, { pageSize: 200 });
  base = "http://graph.test";
} else if (!process.env.GRAPH_TOKEN) {
  throw new Error("set GRAPH_TOKEN, or pass --fake");
}
const latency = values.fake ? Number(values.latency) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stats = { requests: 0, throttled: 0, retries: 0 };
/** GET with Retry-After backoff on 429/503/504, as a connector must do. */
async function get<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    stats.requests++;
    if (latency) await sleep(latency);
    const res = fake
      ? await fake.fetch(url, { headers: { authorization: `Bearer ${token}` } })
      : await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 8) {
      if (res.status === 429) stats.throttled++;
      stats.retries++;
      await sleep(Number(res.headers.get("retry-after") ?? 2 ** attempt) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}
async function all<T>(url: string): Promise<{ items: T[]; deltaLink?: string }> {
  const items: T[] = [];
  let next: string | undefined = url;
  let deltaLink: string | undefined;
  while (next) {
    const page: Page<T> = await get<Page<T>>(next);
    items.push(...page.value);
    next = page["@odata.nextLink"];
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
  }
  return deltaLink === undefined ? { items } : { items, deltaLink };
}
/** Runs `fn` over `xs` with at most `limit` in flight. */
async function pool<T>(
  xs: readonly T[],
  limit: number,
  fn: (x: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < xs.length) await fn(xs[i++] as T);
    }),
  );
}

// ── 1. Full crawl: sites → drives → delta (every item) → permissions per item ───────────────
const t0 = performance.now();
const sites = (await all<{ id: string }>(`${base}/v1.0/sites?search=*&$top=200`)).items;
const drives: { id: string; site: string }[] = [];
for (const s of sites) {
  for (const d of (await all<{ id: string }>(`${base}/v1.0/sites/${s.id}/drives`)).items)
    drives.push({ id: d.id, site: s.id });
}
const deltaLinks = new Map<string, string>();
const crawled: (DriveItem & { drive: string })[] = [];
await pool(drives, concurrency, async (d) => {
  const r = await all<DriveItem>(`${base}/v1.0/drives/${d.id}/root/delta?$top=200`);
  for (const item of r.items) if (!item.root) crawled.push({ ...item, drive: d.id });
  if (r.deltaLink) deltaLinks.set(d.id, r.deltaLink);
});
const crawlMs = performance.now() - t0;

const acls = new Map<string, Permission[]>();
const t1 = performance.now();
await pool(crawled, concurrency, async (item) => {
  acls.set(
    item.id,
    (await all<Permission>(`${base}/v1.0/drives/${item.drive}/items/${item.id}/permissions`)).items,
  );
});
const aclMs = performance.now() - t1;

// ── 2. ACL correctness (fake only: ground truth is known) ───────────────────────────────────
let aclChecked = 0;
let aclWrong = 0;
if (tenant) {
  const access = new AccessModel(tenant);
  const byId = new Map(tenant.items.map((i) => [i.id, i]));
  const guestId = new Map(tenant.users.filter((u) => u.guest).map((u) => [u.upn, u.id]));
  const members = new Map(tenant.groups.map((g) => [g.id, g.members]));
  const active = new Set(tenant.users.filter((u) => u.active).map((u) => u.id));
  for (const [id, perms] of acls) {
    const item = byId.get(id);
    if (!item) continue;
    // Readers as a connector would derive them from Graph permissions (links grant nobody).
    const readers = new Set<string>();
    for (const p of perms) {
      if (p.link) continue;
      const g = p.grantedToV2?.group?.id;
      const u = p.invitation ? guestId.get(p.invitation.email) : p.grantedToV2?.user?.id;
      for (const who of g ? (members.get(g) ?? []) : u ? [u] : [])
        if (active.has(who)) readers.add(who);
    }
    const truth = access.readersOf(item);
    aclChecked++;
    if (readers.size !== truth.size || [...truth].some((r) => !readers.has(r))) aclWrong++;
  }
}

// ── 3. Delta lag: change files, then measure one incremental round ──────────────────────────
let deltaMs = Number.NaN;
let deltaSeen = 0;
const changed = Number(values.changes);
if (fake) {
  const files = crawled.filter((i) => i.file).slice(0, changed);
  for (const f of files) fake.store.update(f.id, { name: `changed ${f.name}` });
  const t2 = performance.now();
  await pool([...deltaLinks], concurrency, async ([drive, link]) => {
    const r = await all<DriveItem>(link);
    deltaSeen += r.items.filter((i) => !i.root).length;
    if (r.deltaLink) deltaLinks.set(drive, r.deltaLink);
  });
  deltaMs = performance.now() - t2;
}

const perHour = (n: number, ms: number) => Math.round((n / ms) * 3_600_000);
const files = crawled.filter((i) => i.file).length;
console.log(
  `# Spike S4 against ${fake ? `the fake Graph (${values.items} items, ${latency} ms simulated latency)` : base}`,
);
console.log(
  `sites ${sites.length}, drives ${drives.length}, items ${crawled.length} (${files} files), concurrency ${concurrency}`,
);
console.log(
  `crawl (delta, $top 200): ${(crawlMs / 1000).toFixed(1)} s → ${perHour(crawled.length, crawlMs).toLocaleString("en-US")} items/hour`,
);
console.log(
  `permissions (1 call per item): ${(aclMs / 1000).toFixed(1)} s → ${perHour(crawled.length, aclMs).toLocaleString("en-US")} items/hour`,
);
const totalFor100k = ((100_000 / crawled.length) * (crawlMs + aclMs)) / 60_000;
console.log(
  `projected time for 100k items: ${totalFor100k.toFixed(1)} min (pass < 120 min: ${totalFor100k < 120})`,
);
console.log(`requests ${stats.requests}, throttled ${stats.throttled}, retries ${stats.retries}`);
if (tenant)
  console.log(`ACLs: ${aclChecked} items checked against ground truth, ${aclWrong} wrong`);
if (fake)
  console.log(
    `delta after ${changed} changes: ${deltaSeen} items in one round across ${deltaLinks.size} drives, ${deltaMs.toFixed(0)} ms`,
  );
