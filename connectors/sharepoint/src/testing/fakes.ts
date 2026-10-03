import { FakeEntra, FakeGraph, generateTenant, type FakeTenant } from "@openhoard/testkit";

/** An app registration's client id, as the tests' apps use it. */
export const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
export const SECRET = "s3cr3t~value-of-the-client-secret";
/** Where the fakes are "served": nothing is listening, requests go to them in process. */
export const AUTHORITY = "https://login.test";
export const GRAPH = "https://graph.test";

export interface Fakes {
  tenant: FakeTenant;
  entra: FakeEntra;
  graph: FakeGraph;
  /** A clock the tests move. */
  clock: { now: number };
  /** A `fetch` that reaches the fake Entra and the fake Graph by their origins. */
  fetch: typeof fetch;
  /** Every request `fetch` sent, in order. */
  sent: { url: string; init: RequestInit | undefined }[];
}

/** A tenant id as Entra's are, which the fake Entra answers to as well as to its domain. */
export const TENANT_GUID = "0f0e0d0c-0b0a-4908-8706-050403020100";

export function fakes(
  options: {
    lifetimeSeconds?: number;
    items?: number;
    maxFileBytes?: number;
    pageSize?: number;
    /** False: no file has a content hash (FakeGraphOptions.contentHashes). */
    contentHashes?: boolean;
  } = {},
): Fakes {
  const { items = 200, maxFileBytes, pageSize, contentHashes, ...entraOptions } = options;
  const tenant = generateTenant({ items });
  // Small files, for tests that read every one: the generator's run to gigabytes.
  if (maxFileBytes !== undefined) {
    for (const item of tenant.items) item.size = Math.min(item.size, maxFileBytes);
  }
  const clock = { now: Date.parse("2026-10-02T12:00:00Z") };
  const entra = new FakeEntra(tenant, {
    graph: GRAPH,
    now: () => clock.now,
    aliases: [TENANT_GUID],
    ...entraOptions,
  });
  const graph = new FakeGraph(tenant, {
    entra,
    now: () => clock.now,
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(contentHashes === undefined ? {} : { contentHashes }),
  });
  const sent: Fakes["sent"] = [];
  const send: typeof fetch = (input, init) => {
    const url = String(input);
    sent.push({ url, init });
    if (url.startsWith(`${AUTHORITY}/`)) return entra.fetch(url, init);
    if (url.startsWith(`${GRAPH}/`)) return graph.fetch(url, init);
    return Promise.reject(new TypeError(`fetch failed: nothing at ${url}`));
  };
  return { tenant, entra, graph, clock, fetch: send, sent };
}
