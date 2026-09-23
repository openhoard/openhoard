// Spike S3 (T-022): can Cedar make OpenHoard's authorization decisions in Node 24 fast enough?
// Pass: ESM import works and a decision against 1,000 policies takes < 1 ms (p95), else OpenFGA.
//   pnpm --filter @openhoard/spike-s3-cedar spike
//
// Throwaway code: it answers one question and is not production code. See docs/spikes/s3-cedar.md.
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import {
  generateTenant,
  measureLatency,
  Random,
  type FakeItem,
  type FakeTenant,
} from "@openhoard/testkit";

const SCHEMA = `
namespace OpenHoard {
  entity Group;
  entity User in [Group] { guest: Bool };
  entity File { tags: Set<String>, owner: User };
  action read, search appliesTo { principal: User, resource: File, context: { client: String } };
  action share appliesTo { principal: User, resource: File, context: { client: String } };
}`;

const tenant: FakeTenant = generateTenant({ items: 10_000 });
const rng = new Random("s3");

// ── 1,000 policies shaped like OpenHoard's: access is granted to tags, mostly via groups ───
// Real tenants have many tag values (projects, matters, clients). The fake tenant's labels are
// few, so every file also gets one of 150 project tags.
const PROJECTS = 150;
const projectOf = new Map(
  tenant.items.map((i) => [i.id, `project:p${String(rng.int(1, PROJECTS)).padStart(3, "0")}`]),
);
const tagsOf = (file: FakeItem) => [...file.labels, projectOf.get(file.id) as string];
const labels = [
  ...new Set(tenant.items.flatMap((i) => i.labels)),
  ...Array.from({ length: PROJECTS }, (_, n) => `project:p${String(n + 1).padStart(3, "0")}`),
].sort();
const groups = tenant.groups.map((g) => g.id);
const grants: { group: string; tag: string }[] = [];
const seen = new Set<string>();
while (grants.length < 994) {
  const g = { group: rng.pick(groups), tag: rng.pick(labels) };
  const key = `${g.group}|${g.tag}`;
  if (seen.has(key)) continue;
  seen.add(key);
  grants.push(g);
}
const policies: Record<string, string> = {};
grants.forEach((g, i) => {
  policies[`grant-${i}`] =
    `permit(principal in OpenHoard::Group::"${g.group}", action in [OpenHoard::Action::"read", OpenHoard::Action::"search"], resource) when { resource.tags.contains("${g.tag}") };`;
});
policies["owner"] = `permit(principal, action, resource) when { resource.owner == principal };`;
policies["no-guest-share"] =
  `forbid(principal, action == OpenHoard::Action::"share", resource) when { principal.guest };`;
policies["restricted-no-consumer-ai"] =
  `forbid(principal, action, resource) when { resource.tags.contains("sensitivity:restricted") && context.client == "consumer" };`;
policies["no-share-restricted"] =
  `forbid(principal, action == OpenHoard::Action::"share", resource) when { resource.tags.contains("sensitivity:restricted") };`;
policies["share-by-writers"] =
  `permit(principal in OpenHoard::Group::"g-leadership", action == OpenHoard::Action::"share", resource) when { resource.tags.contains("sensitivity:internal") };`;
policies["hr-share"] =
  `permit(principal in OpenHoard::Group::"g-hr", action == OpenHoard::Action::"share", resource) when { resource.tags.contains("department:hr") };`;
const policyCount = Object.keys(policies).length;

// ── Reference evaluator: the same rules in plain TypeScript, to check Cedar's answers ─────
const grantsByGroup = new Map<string, Set<string>>();
for (const g of grants)
  grantsByGroup.set(g.group, (grantsByGroup.get(g.group) ?? new Set()).add(g.tag));
const groupsOf = (userId: string) =>
  tenant.groups.filter((g) => g.members.includes(userId)).map((g) => g.id);
function expected(
  userId: string,
  action: string,
  file: FakeItem,
  client: string,
): "allow" | "deny" {
  const user = tenant.users.find((u) => u.id === userId);
  const tags = new Set(tagsOf(file));
  const restricted = tags.has("sensitivity:restricted");
  if (restricted && client === "consumer") return "deny";
  if (action === "share" && (user?.guest || restricted)) return "deny";
  if (file.createdBy === userId) return "allow";
  const mine = groupsOf(userId);
  if (action === "share") {
    if (mine.includes("g-leadership") && tags.has("sensitivity:internal")) return "allow";
    if (mine.includes("g-hr") && tags.has("department:hr")) return "allow";
    return "deny";
  }
  return mine.some((g) => [...(grantsByGroup.get(g) ?? [])].some((t) => tags.has(t)))
    ? "allow"
    : "deny";
}

// ── Requests: real users and files from the fake tenant ───────────────────────────────────
const users = tenant.users.filter((u) => u.active);
const files = tenant.items.filter((i) => i.kind === "file");
interface Req {
  userId: string;
  action: string;
  file: FakeItem;
  client: string;
}
const requests: Req[] = Array.from({ length: 5000 }, () => ({
  userId: rng.pick(users).id,
  action: rng.weighted([
    ["read", 6],
    ["search", 3],
    ["share", 1],
  ] as const),
  file: rng.pick(files),
  client: rng.pick(["person", "local", "commercial", "consumer"]),
}));

const uid = (type: string, id: string) => ({ type: `OpenHoard::${type}`, id });
/** Only the entities a decision needs: the caller, their groups and the file. */
function entitiesFor(r: Req): cedar.Entities {
  const user = tenant.users.find((u) => u.id === r.userId);
  return [
    {
      uid: uid("User", r.userId),
      attrs: { guest: user?.guest ?? false },
      parents: groupsOf(r.userId).map((g) => uid("Group", g)),
    },
    ...groupsOf(r.userId).map((g) => ({ uid: uid("Group", g), attrs: {}, parents: [] })),
    {
      uid: uid("File", r.file.id),
      attrs: { tags: tagsOf(r.file), owner: { __entity: uid("User", r.file.createdBy) } },
      parents: [],
    },
    ...(r.file.createdBy === r.userId
      ? []
      : [{ uid: uid("User", r.file.createdBy), attrs: { guest: false }, parents: [] }]),
  ];
}
const call = (r: Req, entities = entitiesFor(r)) => ({
  principal: uid("User", r.userId),
  action: uid("Action", r.action),
  resource: uid("File", r.file.id),
  context: { client: r.client },
  entities,
});

// ── 1. Parse and validate ─────────────────────────────────────────────────────────────────
const t0 = performance.now();
const schemaOk = cedar.preparseSchema("openhoard", SCHEMA);
const setOk = cedar.preparsePolicySet("openhoard", { staticPolicies: policies });
const preparseMs = performance.now() - t0;
if (schemaOk.type !== "success" || setOk.type !== "success") {
  throw new Error(`parse failed: ${JSON.stringify(schemaOk)} ${JSON.stringify(setOk)}`);
}
const t1 = performance.now();
const validation = cedar.validate({
  schema: SCHEMA,
  policies: { staticPolicies: policies },
  validationSettings: { mode: "strict" },
});
const validateMs = performance.now() - t1;
const validationErrors = validation.type === "success" ? validation.validationErrors.length : -1;

// ── 2. Correctness against the reference evaluator ────────────────────────────────────────
let mismatches = 0;
let allows = 0;
for (const r of requests) {
  const answer = cedar.statefulIsAuthorized({
    ...call(r),
    preparsedPolicySetId: "openhoard",
    preparsedSchemaName: "openhoard",
    validateRequest: true,
  });
  if (answer.type !== "success") throw new Error(JSON.stringify(answer.errors));
  const decision = answer.response.decision;
  if (decision === "allow") allows++;
  if (decision !== expected(r.userId, r.action, r.file, r.client)) mismatches++;
}

// ── 3. Latency: one set of 1,000 policies ─────────────────────────────────────────────────
const prepared = requests.map((r) => call(r));
const stateful = await measureLatency(
  (i) =>
    cedar.statefulIsAuthorized({
      ...(prepared[i % prepared.length] as ReturnType<typeof call>),
      preparsedPolicySetId: "openhoard",
      preparsedSchemaName: "openhoard",
      validateRequest: true,
    }),
  { iterations: 2_000, warmup: 200 },
);
const statefulNoValidate = await measureLatency(
  (i) =>
    cedar.statefulIsAuthorized({
      ...(prepared[i % prepared.length] as ReturnType<typeof call>),
      preparsedPolicySetId: "openhoard",
    }),
  { iterations: 2_000, warmup: 200 },
);
const stateless = await measureLatency(
  (i) =>
    cedar.isAuthorized({
      ...(prepared[i % prepared.length] as ReturnType<typeof call>),
      policies: { staticPolicies: policies },
    }),
  { iterations: 30, warmup: 3 },
);

// ── 3b. Latency: the same policies split by the tag they grant ────────────────────────────
// Cedar is deny-overrides with default deny, so evaluating disjoint subsets and combining
// ("any forbid → deny, else any permit → allow") gives the same answer as the whole set.
// Grants are tag-scoped, so a request only needs the global set plus one set per file tag.
const byTag = new Map<string, Record<string, string>>();
const global: Record<string, string> = {};
for (const [id, text] of Object.entries(policies)) {
  const tag = id.startsWith("grant-") ? grants[Number(id.slice(6))]?.tag : undefined;
  if (tag) byTag.set(tag, { ...(byTag.get(tag) ?? {}), [id]: text });
  else global[id] = text;
}
if (cedar.preparsePolicySet("global", { staticPolicies: global }).type !== "success")
  throw new Error("global");
for (const [tag, set] of byTag) {
  if (cedar.preparsePolicySet(`tag:${tag}`, { staticPolicies: set }).type !== "success")
    throw new Error(tag);
}
function partitioned(r: Req, c = call(r)): "allow" | "deny" {
  const sets = [
    "global",
    ...tagsOf(r.file)
      .filter((t) => byTag.has(t))
      .map((t) => `tag:${t}`),
  ];
  let permit = false;
  for (const id of sets) {
    const a = cedar.statefulIsAuthorized({
      ...c,
      preparsedPolicySetId: id,
      preparsedSchemaName: "openhoard",
      validateRequest: true,
    });
    if (a.type !== "success") return "deny"; // fail closed
    const reasons = a.response.diagnostics.reason;
    const forbids = reasons.some(
      (p) => !String(p).startsWith("grant-") && policies[String(p)]?.startsWith("forbid"),
    );
    if (forbids) return "deny";
    if (a.response.decision === "allow") permit = true;
  }
  return permit ? "allow" : "deny";
}
let partitionMismatches = 0;
for (const r of requests)
  if (partitioned(r) !== expected(r.userId, r.action, r.file, r.client)) partitionMismatches++;
const split = await measureLatency(
  (i) => partitioned(requests[i % requests.length] as Req, prepared[i % prepared.length]),
  { iterations: 5_000, warmup: 500 },
);
const avgTagSets =
  requests.reduce((n, r) => n + tagsOf(r.file).filter((t) => byTag.has(t)).length + 1, 0) /
  requests.length;

// ── 3c. Latency: grants as data, Cedar for the rules ──────────────────────────────────────
// The (group, tag) grants are rows in a table, checked by set intersection (the same principal
// sets the search filter uses). Cedar evaluates only the admin-authored rules: owner, forbids
// and conditional permits, which are few. A rule set can still permit on its own (owner).
const grantKeys = new Set(grants.map((g) => `group:${g.group}|${g.tag}`));
function dataPlusRules(r: Req, c = call(r)): "allow" | "deny" {
  const a = cedar.statefulIsAuthorized({
    ...c,
    preparsedPolicySetId: "global",
    preparsedSchemaName: "openhoard",
    validateRequest: true,
  });
  if (a.type !== "success") return "deny"; // fail closed
  const forbidden = a.response.diagnostics.reason.some((p) =>
    policies[String(p)]?.startsWith("forbid"),
  );
  if (forbidden) return "deny";
  if (a.response.decision === "allow") return "allow";
  if (r.action === "share") return "deny"; // tag grants cover read and search only
  const principals = groupsOf(r.userId).map((g) => `group:${g}`);
  return tagsOf(r.file).some((t) => principals.some((p) => grantKeys.has(`${p}|${t}`)))
    ? "allow"
    : "deny";
}
let rulesMismatches = 0;
for (const r of requests)
  if (dataPlusRules(r) !== expected(r.userId, r.action, r.file, r.client)) rulesMismatches++;
const rules = await measureLatency(
  (i) => dataPlusRules(requests[i % requests.length] as Req, prepared[i % prepared.length]),
  { iterations: 10_000, warmup: 1_000 },
);

// ── 4. Fail closed: a malformed request must never come back "allow" ─────────────────────
const bad = cedar.statefulIsAuthorized({
  ...(prepared[0] as ReturnType<typeof call>),
  entities: [
    { uid: uid("File", "x"), attrs: { tags: 42 }, parents: [] },
  ] as unknown as cedar.Entities,
  preparsedPolicySetId: "openhoard",
  preparsedSchemaName: "openhoard",
  validateRequest: true,
});
const failsClosed = bad.type === "failure" || bad.response.decision === "deny";

const ms = (v: number) => `${v.toFixed(3)} ms`;
console.log(
  `Cedar ${cedar.getCedarVersion()} (SDK ${cedar.getCedarSDKVersion()}), Node ${process.version}, ${process.platform}-${process.arch}`,
);
console.log(
  `policies: ${policyCount} over ${labels.length} tags and ${groups.length} groups; preparse (schema + policies): ${ms(preparseMs)}; strict validation: ${ms(validateMs)}, ${validationErrors} errors`,
);
console.log(
  `correctness: ${requests.length} requests, ${allows} allowed, ${mismatches} mismatches against the reference evaluator`,
);
console.log(
  `one set of ${policyCount}, validated request:     p50 ${ms(stateful.p50)}  p95 ${ms(stateful.p95)}  p99 ${ms(stateful.p99)}`,
);
console.log(
  `one set of ${policyCount}, no request validation: p50 ${ms(statefulNoValidate.p50)}  p95 ${ms(statefulNoValidate.p95)}  p99 ${ms(statefulNoValidate.p99)}`,
);
console.log(`stateless (re-parses every call): p50 ${ms(stateless.p50)}  p95 ${ms(stateless.p95)}`);
console.log(
  `split by tag (${byTag.size} tag sets + global of ${Object.keys(global).length}, avg ${avgTagSets.toFixed(1)} sets/request): p50 ${ms(split.p50)}  p95 ${ms(split.p95)}  p99 ${ms(split.p99)}; ${partitionMismatches} mismatches`,
);
console.log(
  `grants as data + ${Object.keys(global).length} Cedar rules: p50 ${ms(rules.p50)}  p95 ${ms(rules.p95)}  p99 ${ms(rules.p99)}; ${rulesMismatches} mismatches`,
);
console.log(`malformed request fails closed: ${failsClosed} (${bad.type})`);
console.log(`PASS as one set (< 1 ms p95): ${stateful.p95 < 1 && mismatches === 0 && failsClosed}`);
console.log(
  `PASS split by tag (< 1 ms p95): ${split.p95 < 1 && partitionMismatches === 0 && failsClosed}`,
);
console.log(
  `PASS grants as data + rules (< 1 ms p95): ${rules.p95 < 1 && rulesMismatches === 0 && failsClosed}`,
);
