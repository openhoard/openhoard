import { randomBytes } from "node:crypto";
import { exportAudit } from "@openhoard/core-audit";
import { type Database } from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import { createUser, grantAdmin, issueSignInLink, type User } from "@openhoard/core-identity";
import type { StorageJob } from "@openhoard/core-jobs";
import { BlobStore, moveTenantBlobs, TenantBlobStores } from "@openhoard/core-storage";
import { startFakeS3, type FakeS3 } from "@openhoard/core-storage/testing";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";

/*
 * Where a tenant's files are kept, over the admin API: tried, kept (with a recent sign-in),
 * moved by a job, the old copies removed; refused for anyone else, and audited.
 */

const PUBLIC = "http://127.0.0.1:7420";
const SEAL = randomBytes(32);
const KEY = randomBytes(32);

let db: Database;
let t: SeededTenant;
let steve: User;
let s3: FakeS3;
let stores: TenantBlobStores;
let jobs: StorageJob[];
let app: Hono<AuthEnv>;

beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  steve = await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, {
      email: "steve@example.com",
      displayName: "Steve",
      source: "local",
    }),
  );
  s3 = await startFakeS3({ bucket: "acme-hoard", accessKeyId: "AKIAEXAMPLE" });
  stores = new TenantBlobStores({
    db,
    local: BlobStore.open({ kind: "memory" }),
    sealKey: () => SEAL,
  });
  jobs = [];
  app = build(true);
});
afterEach(async () => {
  await db?.close();
  await s3?.close();
});

function build(allowEndpoints: boolean): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: { publicUrl: PUBLIC, cookieKey: "k".repeat(43), signInLinks: true },
  });
  return createApp(config, undefined, {
    db,
    storage: {
      stores,
      keys: { seal: () => SEAL, open: () => SEAL },
      allowEndpoints,
      local: { kind: "memory" },
      requestJob: async (job) => void jobs.push(job),
      keepsFiles: true,
    },
  });
}

const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
async function signedIn(admin = true): Promise<string> {
  if (admin) {
    await db.withTenant(t.tenantId, (tx) =>
      grantAdmin(tx, t.tenantId, steve.id, "system:admin-cli"),
    );
  }
  const { token } = await db.withTenant(t.tenantId, (tx) =>
    issueSignInLink(tx, t.tenantId, { userId: steve.id, by: "system:admin-cli" }),
  );
  const res = await app.request(
    "/auth/link",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC },
      body: new URLSearchParams({ token }).toString(),
    },
    peer,
  );
  return /oh_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
}
const call = (cookie: string, method: "GET" | "POST", path: string, body?: object) =>
  app.request(`/api/admin/storage${path}`, {
    method,
    headers: {
      cookie,
      origin: PUBLIC,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const choice = (over: object = {}) => ({
  kind: "s3",
  bucket: "acme-hoard",
  region: "us-east-1",
  endpoint: s3.endpoint,
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t-access-key",
  ...over,
});
const audited = async (prefix: string) => {
  const lines: string[] = [];
  await exportAudit(
    db,
    t.tenantId,
    { actionPrefix: prefix },
    "ndjson",
    (x: string) => void lines.push(x),
  );
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as { action: string; decision: string; detail?: Record<string, unknown> },
    );
};

describe("a tenant's storage over the admin API", () => {
  it("is the server's disk at first, and an admin's to see", async () => {
    expect((await call(await signedIn(false), "GET", "")).status).toBe(403);
    const res = await call(await signedIn(), "GET", "");
    expect(await res.json()).toMatchObject({
      kind: "local",
      phase: "active",
      previous: null,
      available: true,
      allowEndpoints: true,
      keepsFiles: true,
    });
  });

  it("tries a place and says how each step went, audited without its key", async () => {
    const cookie = await signedIn();
    const ok = await call(cookie, "POST", "/test", { choice: choice() });
    expect(await ok.json()).toEqual({
      ok: true,
      steps: [
        { step: "check", ok: true },
        { step: "write", ok: true },
        { step: "read", ok: true },
        { step: "delete", ok: true },
      ],
    });
    const bad = await call(cookie, "POST", "/test", {
      choice: choice({ bucket: "no-such-bucket" }),
    });
    expect(await bad.json()).toEqual({
      ok: false,
      steps: [
        { step: "check", ok: true },
        { step: "write", ok: false, problem: "not-found", code: "NoSuchBucket" },
      ],
    });
    const invalid = await call(cookie, "POST", "/test", { choice: choice({ bucket: "Bad_Name" }) });
    expect([invalid.status, await invalid.json()]).toEqual([
      400,
      { error: expect.any(String), field: "bucket" },
    ]);
    const events = await audited("storage.test");
    expect(events.map((e) => e.detail)).toEqual([
      expect.objectContaining({ kind: "s3", bucket: "acme-hoard", ok: true }),
      expect.objectContaining({ bucket: "no-such-bucket", ok: false, problem: "not-found" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("s3cr3t");
  });

  it("names no other server unless whoever runs this one allows it", async () => {
    app = build(false);
    const res = await call(await signedIn(), "POST", "/test", { choice: choice() });
    expect([res.status, ((await res.json()) as { field: string }).field]).toEqual([
      400,
      "endpoint",
    ]);
    expect(s3.requests).toEqual([]);
  });

  it("keeps a place that works, after a recent sign-in, and starts the move", async () => {
    const cookie = await signedIn();
    // A place that doesn't work isn't kept.
    const failing = await call(cookie, "POST", "", {
      choice: choice({ bucket: "no-such-bucket" }),
    });
    expect(failing.status).toBe(409);
    expect(await failing.json()).toMatchObject({ probe: { ok: false } });

    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
    try {
      const stale = await call(cookie, "POST", "", { choice: choice() });
      expect([stale.status, await stale.json()]).toEqual([
        403,
        { error: "sign in again to do this", signIn: "/auth/sign-in" },
      ]);
    } finally {
      later.mockRestore();
    }
    expect(jobs).toEqual([]);

    const kept = await call(cookie, "POST", "", { choice: choice() });
    expect([kept.status, await kept.json()]).toEqual([200, { outcome: "moving" }]);
    expect(jobs).toEqual([{ tenantId: t.tenantId, version: 1, task: "move" }]);
    const shown = (await (await call(cookie, "GET", "")).json()) as Record<string, unknown>;
    expect(shown).toMatchObject({
      kind: "s3",
      settings: { bucket: "acme-hoard", accessKeyId: "AKIAEXAMPLE" },
      hasSecret: true,
      phase: "moving",
      previous: { kind: "local" },
      lost: 0,
      changedBy: `user:${steve.id}`,
      changedByName: "Steve",
    });
    expect(JSON.stringify(shown)).not.toContain("s3cr3t");
    // One move at a time.
    const again = await call(cookie, "POST", "", { choice: choice({ prefix: "other" }) });
    expect([again.status, await again.json()]).toEqual([409, { error: expect.any(String) }]);
    expect(
      (await audited("storage.change")).map((e) => [
        e.decision,
        e.detail?.reason ?? e.detail?.outcome,
      ]),
    ).toEqual([
      ["deny", "probe-failed"],
      ["deny", "sign-in-again"],
      ["allow", "moving"],
      ["deny", "moving"],
    ]);
  });

  it("removes the old copies once the move is done, and not before", async () => {
    const cookie = await signedIn();
    await call(cookie, "POST", "", { choice: choice() });
    const early = await call(cookie, "POST", "/remove-old", {});
    expect(early.status).toBe(409);
    await moveTenantBlobs(db, stores, { id: t.tenantId, key: KEY }, 1);
    const res = await call(cookie, "POST", "/remove-old", {});
    expect(res.status).toBe(200);
    expect(jobs.at(-1)).toEqual({ tenantId: t.tenantId, version: 2, task: "clean" });
    expect(((await (await call(cookie, "GET", "")).json()) as { phase: string }).phase).toBe(
      "cleaning",
    );
    // Asked again while it runs (its job lost, say): the same removal, queued again.
    expect((await call(cookie, "POST", "/remove-old", {})).status).toBe(200);
    expect(jobs.at(-1)).toEqual({ tenantId: t.tenantId, version: 2, task: "clean" });
  });
});
