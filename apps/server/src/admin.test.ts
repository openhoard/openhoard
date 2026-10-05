import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import { markProcessed, proposeTag, VIEW_TRANSACTION, viewObjects } from "@openhoard/core-catalog";
import {
  addGrant,
  facetValues,
  newId,
  objects,
  objectTags,
  openDatabase,
  sourceSyncs,
  zones,
  type Database,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
import { addMember, createGroup, createUser, resolvePrincipal } from "@openhoard/core-identity";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import { SoftAuthenticator } from "@openhoard/core-identity/testing";
import { startJobs } from "@openhoard/core-jobs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ACTOR, adminArgument, runAdmin } from "./admin.js";
import { createApp } from "./app.js";
import { ConfigSchema } from "./config.js";

/*
 * T-103's bootstrap: `openhoard admin` creates a tenant and issues, lists and revokes its SCIM
 * tokens. On PGlite it runs against a real data directory (and must refuse while another
 * process, here this one, holds it); on PostgreSQL against the test database.
 */

const postgres = process.env[TEST_POSTGRES_ENV] !== undefined;

let dir: string;
let shared: Database | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "oh-admin-"));
  shared = postgres ? await openTestDatabase() : undefined;
});
afterEach(async () => {
  await shared?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a command; returns its exit code and what it printed. */
async function admin(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runAdmin([...argv, "--data-dir", dir], {
    env: {},
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    // On PostgreSQL, the test database, kept open across commands (each command closes its own).
    ...(shared
      ? {
          open: async () => ({ ...(shared as Database), close: async () => {} }),
          // The queue needs the database itself, not the wrapper above.
          startJobs: (_db, options) => startJobs(shared as Database, options),
        }
      : {}),
  });
  return { code, out, err };
}

/** The database the commands wrote, for checking: reopened on PGlite. */
async function inspect<T>(work: (db: Database) => Promise<T>): Promise<T> {
  if (shared) return work(shared);
  const db = await openDatabase({ url: "pglite", dataDir: dir });
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

describe("adminArgument", () => {
  it("finds admin as the first positional argument, after options", () => {
    expect(adminArgument(["admin", "tenant", "list"])).toBe(0);
    expect(adminArgument(["--data-dir", "/x", "admin", "tenant", "list"])).toBe(2);
    expect(adminArgument(["--data-dir=/x", "admin"])).toBe(1);
    expect(adminArgument([])).toBeUndefined();
    expect(adminArgument(["--data-dir", "/x"])).toBeUndefined();
    expect(adminArgument(["--data-dir", "admin"])).toBeUndefined(); // a directory named admin
    expect(adminArgument(["serve", "admin"])).toBeUndefined();
  });
});

// Every command opens the data directory afresh, as the CLI does: on PGlite that is several
// cold starts per test, which the Windows runners take well over the suite's 30 s for.
describe("openhoard admin", { timeout: 180_000 }, () => {
  it("creates a tenant, issues a SCIM token that works, lists and revokes it, all audited", async () => {
    const created = await admin("tenant", "create", "--name", "Acme");
    expect(created.code, created.err).toBe(0);
    const tenantId = created.out.trim();
    expect(tenantId).toMatch(/^ten_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(created.err).toContain("scim-token issue");

    const listed = await admin("tenant", "list");
    expect(listed.out).toContain(`${tenantId}\t`);
    expect(listed.out).toContain("\tAcme\n");

    const issued = await admin(
      "scim-token",
      "issue",
      "--tenant",
      tenantId,
      "--name",
      "Entra",
      "--days",
      "30",
    );
    expect(issued.code, issued.err).toBe(0);
    const token = issued.out.trim();
    expect(token).toMatch(
      new RegExp(`^ohscim\\.${tenantId}\\.sct_[0-9a-hjkmnp-tv-z]{26}\\.[A-Za-z0-9_-]{43}$`),
    );
    const tokenId = token.split(".")[2] as string;
    expect(issued.err).toContain("shown once");
    expect(issued.err).toContain("<publicUrl>/scim/v2");

    // The token opens the tenant's SCIM endpoint.
    const status = await inspect(async (db) => {
      const app = createApp(ConfigSchema.parse({ dataDir: dir }), undefined, { db });
      const res = await app.request("http://127.0.0.1:7420/scim/v2/Users", {
        headers: { authorization: `Bearer ${token}` },
      });
      return res.status;
    });
    expect(status).toBe(200);

    const tokens = await admin("scim-token", "list", "--tenant", tenantId);
    expect(tokens.out).toMatch(
      new RegExp(`^${tokenId}\\tactive\\texpires .*\\tlast used .*\\tEntra\\n$`),
    );
    expect(tokens.out).not.toContain(token.split(".")[3] as string);

    const revoked = await admin("scim-token", "revoke", "--tenant", tenantId, "--id", tokenId);
    expect(revoked.code, revoked.err).toBe(0);
    expect((await admin("scim-token", "list", "--tenant", tenantId)).out).toContain(`revoked`);
    const again = await admin("scim-token", "revoke", "--tenant", tenantId, "--id", tokenId);
    expect(again.code).toBe(1);
    expect(again.err).toContain("no live SCIM token");
    expect((await admin("scim-token", "revoke", "--tenant", tenantId, "--id", "junk")).code).toBe(
      1,
    );

    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { actor: string; action: string; decision: string; detail?: object },
        );
    });
    const byAdmin = events.filter((e) => e.actor === ADMIN_ACTOR);
    expect(byAdmin.map((e) => [e.action, e.decision])).toEqual([
      ["tenant.create", "allow"],
      ["scim-token.issue", "allow"],
      ["scim-token.revoke", "allow"],
      ["scim-token.revoke", "deny"],
      ["scim-token.revoke", "deny"],
    ]);
    expect(JSON.stringify(byAdmin)).not.toContain(token.split(".")[3] as string);
  });

  // T-106: the first admin comes from the operator; the CLI is also the way back in.
  it("grants, lists and removes admins, never the last, all audited", async () => {
    const tenantId = (await admin("tenant", "create", "--name", "Acme")).out.trim();
    const people = await inspect((db) =>
      db.withTenant(tenantId, async (tx) => {
        const ana = await createUser(tx, tenantId, {
          email: "ana@acme.example",
          displayName: "Ana",
          source: "scim",
          externalId: "entra-ana",
          userName: "ana.upn@acme.example",
        });
        const bo = await createUser(tx, tenantId, {
          email: "bo@acme.example",
          displayName: "Bo",
          source: "local",
        });
        const guest = await createUser(tx, tenantId, {
          email: "gil@partner.example",
          displayName: "Gil",
          source: "local",
          kind: "guest",
        });
        const g = await createGroup(tx, tenantId, {
          name: "Admins",
          source: "scim",
          externalId: "entra-admins",
        });
        const cy = await createUser(tx, tenantId, {
          email: "cy@acme.example",
          displayName: "Cy",
          source: "scim",
          externalId: "entra-cy",
        });
        await addMember(tx, tenantId, g.id, cy.id, "scim");
        return { ana, bo, guest, cy, group: g };
      }),
    );
    const none = await admin("user", "list-admins", "--tenant", tenantId);
    expect(none.code).toBe(0);
    expect(none.err).toContain("has no admin");

    const byEmail = await admin(
      "user",
      "grant-admin",
      "--tenant",
      tenantId,
      "--user",
      "ANA@acme.example",
    );
    expect(byEmail.code, byEmail.err).toBe(0);
    expect(byEmail.out.trim()).toBe(people.ana.id);
    expect(byEmail.err).toContain("is an admin now");
    const byUpn = await admin(
      "user",
      "grant-admin",
      "--tenant",
      tenantId,
      "--user",
      "ana.upn@acme.example",
    );
    expect(byUpn.err).toContain("was an admin already");
    const guest = await admin(
      "user",
      "grant-admin",
      "--tenant",
      tenantId,
      "--user",
      people.guest.id,
    );
    expect(guest.code).toBe(1);
    expect(guest.err).toContain("never a guest");
    expect(
      (await admin("user", "grant-admin", "--tenant", tenantId, "--user", "nobody@x.example")).code,
    ).toBe(1);

    const last = await admin("user", "revoke-admin", "--tenant", tenantId, "--user", people.ana.id);
    expect(last.code).toBe(1);
    expect(last.err).toContain("last admin");
    expect(
      (await admin("user", "grant-admin", "--tenant", tenantId, "--user", people.bo.id)).code,
    ).toBe(0);
    const listed = await admin("user", "list-admins", "--tenant", tenantId);
    expect(listed.out).toContain(`${people.ana.id}\trole\tactive\tana@acme.example\tAna\n`);
    expect(listed.out).toContain(`${people.bo.id}\trole\tactive\t`);
    const removed = await admin(
      "user",
      "revoke-admin",
      "--tenant",
      tenantId,
      "--user",
      "ana.upn@acme.example",
    );
    expect(removed.code, removed.err).toBe(0);
    expect(removed.err).toContain("no longer an admin");

    // The operator finds the group's id, and names it in the config: its members count and stay
    // the provider's.
    const groups = await admin("group", "list", "--tenant", tenantId);
    expect(groups.code, groups.err).toBe(0);
    expect(groups.out).toBe(`${people.group.id}\tscim\t1\tentra-admins\tAdmins\n`);
    const config = (groupId: string) =>
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          auth: { publicUrl: "https://hoard.example.com", adminGroups: [{ tenantId, groupId }] },
        }),
      );
    config(people.group.id);
    expect((await admin("group", "list", "--tenant", tenantId)).out).toContain("\tadmin group\n");
    const withGroup = await admin("user", "list-admins", "--tenant", tenantId);
    expect(withGroup.out).toContain(`${people.cy.id}\tgroup\tactive\t`);
    const cy = await admin("user", "revoke-admin", "--tenant", tenantId, "--user", people.cy.id);
    expect(cy.code).toBe(1);
    expect(cy.err).toContain("admin group");
    // Cy counts, so Bo, the last with the role, may go.
    expect(
      (await admin("user", "revoke-admin", "--tenant", tenantId, "--user", people.bo.id)).code,
    ).toBe(0);
    // A group that isn't there makes nobody an admin, and the listing says so.
    config("grp_" + "0".repeat(26));
    const gone = await admin("user", "list-admins", "--tenant", tenantId);
    expect(gone.out).not.toContain(people.cy.id);
    expect(gone.err).toContain("doesn't exist: it makes nobody an admin");
    const unknown = "ten_" + "0".repeat(26);
    expect((await admin("user", "list-admins", "--tenant", unknown)).code).toBe(1);
    expect((await admin("group", "list", "--tenant", unknown)).code).toBe(1);
    expect((await admin("user", "grant-admin", "--tenant", unknown, "--user", "x")).code).toBe(1);
    expect((await admin("user", "grant-admin", "--tenant", tenantId)).code).toBe(2);

    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as { action: string; decision: string; detail?: { reason?: string } },
        );
    });
    expect(
      events
        .filter((e) => e.action.startsWith("admin."))
        .map((e) => `${e.action}:${e.decision}:${e.detail?.reason ?? ""}`),
    ).toEqual([
      "admin.grant:allow:",
      "admin.grant:allow:",
      "admin.grant:deny:not-a-member",
      "admin.grant:deny:unknown-user",
      "admin.revoke:deny:last-admin",
      "admin.grant:allow:",
      "admin.revoke:allow:",
      "admin.revoke:deny:admin-group",
      "admin.revoke:allow:",
    ]);
  });

  it("lists connector syncs, confirms a held reconcile and accepts a new identity, audited", async () => {
    const tenantId = (await admin("tenant", "create", "--name", "Acme")).out.trim();
    await inspect((db) =>
      db.withTenant(tenantId, async (tx) => {
        const zoneId = newId("zone");
        await tx.insert(zones).values({ tenantId, id: zoneId, kind: "indexed", name: "Shares" });
        await tx.insert(sourceSyncs).values({
          tenantId,
          source: "fs-main",
          zoneId,
          connector: "connector-fs",
          phase: "delta",
          token: "fs1.x",
          reconcileFrom: new Date(),
          reconcileHeld: 60,
          sourceIdentity: "66306:1234",
        });
      }),
    );
    const listed = await admin("source", "list", "--tenant", tenantId);
    expect(listed.out).toMatch(
      /^fs-main\tconnector-fs\tzon_\S+\tdelta\t\S+\tnever run\treconcile held: 60/,
    );

    const confirmed = await admin(
      "source",
      "confirm-reconcile",
      "--tenant",
      tenantId,
      "--source",
      "fs-main",
    );
    expect(confirmed.code, confirmed.err).toBe(0);
    expect(confirmed.err).toContain("up to 60 items");
    expect((await admin("source", "list", "--tenant", tenantId)).out).toContain("(confirmed 60)");
    const none = await admin(
      "source",
      "confirm-reconcile",
      "--tenant",
      tenantId,
      "--source",
      "nope",
    );
    expect([none.code, none.err]).toEqual([
      1,
      "source nope has no reconcile held for confirmation\n",
    ]);

    // Discarding drops the held reconcile, removes nothing, and has the source crawled afresh.
    const discarded = await admin(
      "source",
      "discard-reconcile",
      "--tenant",
      tenantId,
      "--source",
      "fs-main",
    );
    expect(discarded.code, discarded.err).toBe(0);
    expect(discarded.err).toContain("nothing was removed");
    const [fresh] = await inspect((db) =>
      db.withTenant(tenantId, (tx) => tx.select().from(sourceSyncs)),
    );
    expect(fresh).toMatchObject({ phase: "crawl", token: null, reconcileHeld: null });
    expect(fresh?.reconcileFrom).toBeInstanceOf(Date);
    const again = await admin(
      "source",
      "discard-reconcile",
      "--tenant",
      tenantId,
      "--source",
      "fs-main",
    );
    expect([again.code, again.err]).toEqual([
      1,
      "source fs-main has no reconcile held or deferred\n",
    ]);

    const accepted = await admin(
      "source",
      "accept-identity",
      "--tenant",
      tenantId,
      "--source",
      "fs-main",
    );
    expect(accepted.code, accepted.err).toBe(0);
    const state = await inspect((db) =>
      db.withTenant(tenantId, (tx) => tx.select().from(sourceSyncs)),
    );
    expect(state[0]).toMatchObject({
      sourceIdentity: null,
      phase: "crawl",
      token: null,
      reconcileHeld: null,
    });
    expect(
      (await admin("source", "accept-identity", "--tenant", tenantId, "--source", "nope")).code,
    ).toBe(1);
    expect((await admin("source", "list", "--tenant", tenantId, "--source", "x")).code).toBe(0);
    expect(
      (await admin("source", "confirm-reconcile", "--tenant", tenantId, "--source", "Bad Name"))
        .code,
    ).toBe(2);
    expect((await admin("source", "confirm-reconcile", "--tenant", tenantId)).code).toBe(2);

    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; decision: string; detail?: object });
    });
    expect(
      events
        .filter((e) => e.action.startsWith("source."))
        .map((e) => [e.action, e.decision, e.detail]),
    ).toEqual([
      ["source.confirm-reconcile", "allow", { source: "fs-main", confirmed: 60 }],
      ["source.confirm-reconcile", "deny", { source: "nope", reason: "nothing-held" }],
      ["source.discard-reconcile", "allow", { source: "fs-main" }],
      ["source.discard-reconcile", "deny", { source: "fs-main", reason: "nothing-held" }],
      ["source.accept-identity", "allow", { source: "fs-main" }],
      ["source.accept-identity", "deny", { source: "nope", reason: "unknown-source" }],
    ]);
  });

  it("shows a source's last run, resumes a stopped one and queues a run, audited", async () => {
    const tenantId = (await admin("tenant", "create", "--name", "Acme")).out.trim();
    await inspect((db) =>
      db.withTenant(tenantId, async (tx) => {
        const zoneId = newId("zone");
        await tx.insert(zones).values({ tenantId, id: zoneId, kind: "indexed", name: "Docs" });
        await tx.insert(sourceSyncs).values({
          tenantId,
          source: "fs-docs",
          zoneId,
          connector: "connector-fs",
          phase: "delta",
          token: "fs1.x",
          lastRunAt: new Date(),
          lastStatus: "failed",
          lastError: "auth",
          lastCounts: { files: 3, ingested: 0 },
          stoppedAt: new Date(),
          stoppedError: "auth",
        });
      }),
    );
    expect((await admin("source", "list", "--tenant", tenantId)).out).toContain(
      "\tstopped: auth\t",
    );
    const status = await admin("source", "status", "--tenant", tenantId, "--source", "fs-docs");
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("state: STOPPED since");
    expect(status.out).toContain("last status: failed (auth)\n");
    expect(status.out).toContain("last counts: files 3, ingested 0\n");
    expect((await admin("source", "status", "--tenant", tenantId, "--source", "nope")).code).toBe(
      1,
    );

    const refused = await admin("source", "run-now", "--tenant", tenantId, "--source", "fs-docs");
    expect([refused.code, refused.err]).toEqual([
      1,
      "source fs-docs is stopped: fix what failed (source status), then source resume\n",
    ]);
    const resumed = await admin("source", "resume", "--tenant", tenantId, "--source", "fs-docs");
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.err).toContain("it was stopped for auth");
    expect(
      (await admin("source", "resume", "--tenant", tenantId, "--source", "fs-docs")).code,
    ).toBe(1);
    expect((await admin("source", "status", "--tenant", tenantId)).out).toContain(
      "state: scheduled\n",
    );
    const queued = await admin("source", "run-now", "--tenant", tenantId, "--source", "fs-docs");
    expect(queued.code, queued.err).toBe(0);
    expect(queued.err).toContain("Queued a sync of fs-docs");
    expect((await admin("source", "run-now", "--tenant", tenantId, "--source", "nope")).code).toBe(
      1,
    );
    const jobs = await inspect(async (db) => {
      const j = await startJobs(db, { worker: false, maintenance: false });
      try {
        return await j.boss.findJobs("sync", { key: `${tenantId}/fs-docs`, queued: true });
      } finally {
        await j.stop({ timeoutMs: 1_000 });
      }
    });
    expect(jobs.map((j) => j.data)).toEqual([{ tenantId, source: "fs-docs" }]);

    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; decision: string; detail?: object });
    });
    expect(
      events
        .filter((e) => e.action.startsWith("source."))
        .map((e) => [e.action, e.decision, e.detail]),
    ).toEqual([
      ["source.run-now", "deny", { source: "fs-docs", reason: "stopped" }],
      ["source.resume", "allow", { source: "fs-docs", was: "auth" }],
      ["source.resume", "deny", { source: "fs-docs", reason: "not-stopped" }],
      ["source.run-now", "allow", { source: "fs-docs" }],
      ["source.run-now", "deny", { source: "nope", reason: "unknown-source" }],
    ]);
  });

  it("makes a local person and a one-time sign-in link, only where links are on", async () => {
    const tenantId = (await admin("tenant", "create", "--name", "Solo")).out.trim();
    const made = await admin(
      "user",
      "create",
      "--tenant",
      tenantId,
      "--email",
      "steve@example.com",
      "--name",
      "Steve",
    );
    expect(made.code, made.err).toBe(0);
    const userId = made.out.trim();
    expect(userId).toMatch(/^usr_/);
    const twice = await admin(
      "user",
      "create",
      "--tenant",
      tenantId,
      "--email",
      "steve@example.com",
      "--name",
      "Steve",
    );
    expect([twice.code, twice.err]).toEqual([
      1,
      `someone in tenant ${tenantId} has that email already\n`,
    ]);
    // Off unless the config turns links on.
    const off = await admin("user", "sign-in-link", "--tenant", tenantId, "--user", userId);
    expect(off.code).toBe(1);
    expect(off.err).toContain("sign-in links are off");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ auth: { publicUrl: "http://127.0.0.1:7420", signInLinks: true } }),
    );
    const link = await admin(
      "user",
      "sign-in-link",
      "--tenant",
      tenantId,
      "--user",
      "steve@example.com",
      "--minutes",
      "5",
    );
    expect(link.code, link.err).toBe(0);
    expect(link.out).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:7420/auth/link\\?token=ohl\\.${tenantId}\\.sil_\\S+\\n$`),
    );
    expect(
      (
        await admin(
          "user",
          "sign-in-link",
          "--tenant",
          tenantId,
          "--user",
          userId,
          "--minutes",
          "90",
        )
      ).code,
    ).toBe(2);
    const nobody = await admin("user", "sign-in-link", "--tenant", tenantId, "--user", "x@y.z");
    expect(nobody.code).toBe(1);
    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; decision: string; detail?: object });
    });
    expect(
      events
        .filter((e) => e.action === "user.create" || e.action === "sign-in-link.issue")
        .map((e) => [e.action, e.decision]),
    ).toEqual([
      ["user.create", "allow"],
      ["user.create", "deny"],
      ["sign-in-link.issue", "allow"],
      ["sign-in-link.issue", "deny"],
    ]);
    // The token is never in the audit log.
    expect(JSON.stringify(events)).not.toContain(link.out.trim().split("token=")[1]);
  });

  it("invites a local person to make a passkey, lists it and removes it", async () => {
    const tenantId = (await admin("tenant", "create", "--name", "Solo")).out.trim();
    const userId = (
      await admin(
        "user",
        "create",
        "--tenant",
        tenantId,
        "--email",
        "bo@example.com",
        "--name",
        "Bo",
      )
    ).out.trim();
    const invite = (...more: string[]) =>
      admin("user", "invite", "--tenant", tenantId, "--user", "bo@example.com", ...more);
    // Off unless the config turns passkeys on.
    const off = await invite();
    expect([off.code, off.out]).toEqual([1, ""]);
    expect(off.err).toContain("passkeys are off");
    const publicUrl = "https://files.example.com";
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ auth: { publicUrl, passkeys: true } }),
    );
    expect((await invite("--hours", "169")).code).toBe(2);
    expect((await invite("--hours", "x")).code).toBe(2);
    const first = await invite("--hours", "2");
    expect(first.code, first.err).toBe(0);
    // The token is the link's fragment: a browser sends it to no server.
    expect(first.out).toMatch(
      new RegExp(`^https://files\\.example\\.com/auth/invite#ohi\\.${tenantId}\\.inv_\\S+\\n$`),
    );
    const second = await invite();
    expect(second.err).toContain("Their earlier invite no longer works.");
    const nobody = await admin("user", "invite", "--tenant", tenantId, "--user", "x@y.z");
    expect(nobody.code).toBe(1);

    // The person opens the link: the server makes their passkey (passkeys.test.ts has the rest).
    const device = new SoftAuthenticator();
    const use = (link: string) =>
      inspect(async (db) => {
        const config = ConfigSchema.parse({
          dataDir: dir,
          auth: { publicUrl, passkeys: true, cookieKey: "k".repeat(43) },
        });
        const app = createApp(config, undefined, { db });
        const token = link.trim().split("#")[1];
        const headers = { "content-type": "application/json", origin: publicUrl };
        const options = await app.request("/auth/passkey/register/options", {
          method: "POST",
          headers,
          body: JSON.stringify({ invite: token }),
        });
        if (options.status !== 200) return options.status;
        const cookie = (options.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const done = await app.request("/auth/passkey/register", {
          method: "POST",
          headers: { ...headers, cookie },
          body: JSON.stringify({
            invite: token,
            response: device.create((await options.json()) as Record<string, unknown>, publicUrl),
          }),
        });
        return done.status;
      });
    expect(await use(first.out)).toBe(401);
    expect(await use(second.out)).toBe(200);

    const list = () => admin("user", "list-passkeys", "--tenant", tenantId, "--user", userId);
    const listed = await list();
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toMatch(
      /^pky_\S+\tPasskey\tcreated \S+\tnever used\tsynced\tfiles\.example\.com\n$/,
    );
    const passkeyId = listed.out.split("\t")[0] as string;
    const remove = (id: string) =>
      admin("user", "remove-passkey", "--tenant", tenantId, "--user", userId, "--id", id);
    expect((await remove("nonsense")).code).toBe(2);
    expect((await remove("pky_00000000000000000000000000")).code).toBe(1);
    const removed = await remove(passkeyId);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.err).toContain("ended 1 session(s)");
    expect((await list()).out).toBe("");

    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; decision: string; detail?: object });
    });
    expect(
      events
        .filter((e) => /^(invite|passkey)\./.test(e.action) || e.action === "auth.sign-in")
        .map((e) => [e.action, e.decision]),
    ).toEqual([
      ["invite.issue", "allow"],
      ["invite.issue", "allow"],
      ["invite.issue", "deny"],
      // (The replaced invite was refused when its page asked for options: nothing began.)
      ["passkey.register", "allow"],
      ["auth.sign-in", "allow"],
      ["passkey.remove", "allow"],
    ]);
    // No invite's secret is in the audit log.
    for (const link of [first, second]) {
      expect(JSON.stringify(events)).not.toContain(link.out.trim().split(".").at(-1));
    }
  });

  it("plans a pack, applies exactly that plan, and refuses a stale hash, audited", async () => {
    const tenantId = (await admin("tenant", "create", "--name", "Acme")).out.trim();
    const file = join(dir, "pack.json");
    const pack = {
      pack_version: 1,
      name: "tiny",
      version: "1.0.0",
      defaults: { visibility: "discoverable", exposure: "commercial-only" },
      facets: [{ key: "kind", label: "Kind", values: [{ value: "memo", label: "Memo" }] }],
    };
    writeFileSync(file, JSON.stringify(pack));
    const plan = await admin("pack", "plan", "--tenant", tenantId, "--file", file);
    expect(plan.code, plan.err).toBe(0);
    const hash = plan.out.trim();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.err).toContain(
      "! set-defaults defaults hidden/metadata-only -> discoverable/commercial-only",
    );
    expect(plan.err).toContain("pack apply");
    expect(
      (await admin("pack", "apply", "--tenant", tenantId, "--file", file)).code,
      "no hash",
    ).toBe(2);
    const stale = await admin(
      "pack",
      "apply",
      "--tenant",
      tenantId,
      "--file",
      file,
      "--plan-hash",
      "0".repeat(64),
    );
    expect(stale.code).toBe(1);
    const applied = await admin(
      "pack",
      "apply",
      "--tenant",
      tenantId,
      "--file",
      file,
      "--plan-hash",
      hash,
    );
    expect(applied.code, applied.err).toBe(0);
    expect(applied.err).toContain("Applied: pack tiny 1.0.0");
    expect(
      (await admin("pack", "plan", "--tenant", tenantId, "--file", join(dir, "none.json"))).code,
    ).toBe(1);
    const events = await inspect(async (db) => {
      const lines: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
      return lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { action: string; decision: string; detail?: object });
    });
    expect(
      events.filter((e) => e.action === "pack.apply").map((e) => [e.decision, e.detail]),
    ).toEqual([
      ["deny", { reason: "stale-plan" }],
      ["allow", { pack: "tiny", version: "1.0.0", planHash: hash, loosening: 1 }],
    ]);
  });

  it("prints the Tenant URL when the server's public URL is configured", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ auth: { publicUrl: "https://hoard.example.com" } }),
    );
    const tenantId = (await admin("tenant", "create", "--name", "Acme")).out.trim();
    const issued = await admin("scim-token", "issue", "--tenant", tenantId, "--name", "Entra");
    expect(issued.code, issued.err).toBe(0);
    expect(issued.err).toContain("Tenant URL: https://hoard.example.com/scim/v2\n");
    // A year by default, the most a token may live.
    const listed = (await admin("scim-token", "list", "--tenant", tenantId)).out;
    const expires = new Date(/expires (\S+)/.exec(listed)?.[1] ?? "").getTime();
    expect(expires - Date.now()).toBeGreaterThan(364 * 24 * 3600 * 1000);
  });

  it("refuses misuse with the usage, and unknown tenants", async () => {
    const usage = [
      [],
      ["tenant"],
      ["tenant", "delete"],
      ["tenant", "create"],
      ["tenant", "create", "--bogus"],
      ["scim-token", "issue", "--tenant", "ten_nope", "--name", "x"],
      ["scim-token", "list"],
    ];
    for (const argv of usage) {
      const res = await admin(...argv);
      expect(res.code, argv.join(" ")).toBe(2);
      expect(res.err).toContain("usage: openhoard admin");
    }
    const help = await admin("--help");
    expect(help.code).toBe(0);
    const tenantId = (await admin("tenant", "create", "--name", "Acme")).out.trim();
    for (const days of ["0", "366", "x", "1.5"]) {
      const res = await admin(
        "scim-token",
        "issue",
        "--tenant",
        tenantId,
        "--name",
        "x",
        "--days",
        days,
      );
      expect(res.code, days).toBe(2);
    }
    const unknown = "ten_" + "0".repeat(26);
    for (const argv of [
      ["scim-token", "issue", "--tenant", unknown, "--name", "x"],
      ["scim-token", "list", "--tenant", unknown],
      ["scim-token", "revoke", "--tenant", unknown, "--id", "sct_x"],
    ]) {
      const res = await admin(...argv);
      expect(res.code, argv.join(" ")).toBe(1);
      expect(res.err).toContain(`no tenant ${unknown}`);
    }
    expect((await admin("tenant", "create", "--name", " ")).code).toBe(1);
    const empty = await admin("scim-token", "list", "--tenant", tenantId);
    expect(empty.err).toContain("has no SCIM tokens");
  });

  it.skipIf(postgres)("refuses clearly while the server holds the embedded database", async () => {
    const server = await openDatabase({ url: "pglite", dataDir: dir });
    try {
      const res = await admin("tenant", "list");
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/in use, most likely by the running OpenHoard server/);
      expect(res.err).toContain("Stop the server");
    } finally {
      await server.close();
    }
    expect((await admin("tenant", "list")).code).toBe(0);
  });

  it("reports a configuration or database it can't use, without the URL", async () => {
    let err = "";
    const code = await runAdmin(["tenant", "list", "--data-dir", dir], {
      env: { OPENHOARD_DATABASE_URL: "mysql://user:secret@host/db" },
      out: () => {},
      err: (s) => void (err += s),
    });
    expect(code).toBe(1);
    expect(err).toContain("cannot open the database");
    expect(err).not.toContain("secret");
    const bad = await runAdmin(["tenant", "list", "--data-dir", dir], {
      env: { OPENHOARD_PORT: "nope" },
      out: () => {},
      err: () => {},
    });
    expect(bad).toBe(1);
  });
});

describe("openhoard admin review (T-1403)", { timeout: 180_000 }, () => {
  it("approves an assistant's proposed tag as a person who may tag the file, and the tag's grant applies", async () => {
    // A file, an editor of it, and someone holding a grant on a tag it doesn't carry yet.
    const made = await inspect(async (db) => {
      const t = await seedTenant(db, 7);
      return db.withTenant(t.tenantId, async (tx) => {
        await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 7.docx" });
        await tx.update(objects).set({ title: "Plan\tQ3\n.docx" });
        const person = async (name: string) =>
          (
            await createUser(tx, t.tenantId, {
              email: `${name}@example.com`,
              displayName: name,
              source: "local",
              kind: "member",
            })
          ).id;
        const [editor, holder] = [await person("ed"), await person("gia")];
        await tx.insert(facetValues).values(
          ["globex", "initech"].map((value) => ({
            tenantId: t.tenantId,
            facet: "client",
            value,
            label: value,
            approved: true,
          })),
        );
        const grant = (principal: string, role: "read" | "write", target: object) =>
          addGrant(tx, t.tenantId, {
            principal: `user:${principal}`,
            role,
            target: target as { objectId: string },
            grantedBy: "user:admin",
          });
        await grant(editor, "write", { objectId: t.objectId });
        const propose = async (tag: string) => {
          const out = await proposeTag(
            tx,
            t.tenantId,
            {
              objectId: t.objectId,
              tag,
              source: "model",
              appliedBy: "model:agent/cli_x",
              confidence: 1,
            },
            { review: "agent" },
          );
          if (out.applied) throw new Error("applied");
          return out.reviewId;
        };
        const reviews = [await propose("client:globex"), await propose("client:initech")];
        await grant(holder, "read", { tag: "client:globex" });
        return { ...t, editor, holder, reviews };
      });
    });
    const { tenantId } = made;
    const [first, second] = made.reviews as [string, string];
    const reads = (userId: string) =>
      inspect((db) =>
        db.withTenant(
          tenantId,
          async (tx) => {
            const principal = await resolvePrincipal(tx, tenantId, userId);
            if (!principal) throw new Error("no principal");
            const [card] = await viewObjects(
              tx,
              tenantId,
              new Authorizer(createCedarEngine()),
              { principal, client: { id: "openhoard-web", trust: "first-party" } },
              [made.objectId],
            );
            return card?.shape === "card" && card.readable;
          },
          VIEW_TRANSACTION,
        ),
      );
    const review = (...argv: string[]) => admin("review", ...argv, "--tenant", tenantId);
    expect(await reads(made.holder)).toBe(false);

    // The inbox, as the editor's: one item a line, the title's control characters gone.
    const listed = await review("list", "--user", "ed@example.com");
    expect(listed.code, listed.err).toBe(0);
    const lines = listed.out.trimEnd().split("\n");
    expect(lines.map((l) => l.split("\t").slice(0, 5))).toEqual([
      [first, "client:globex", "agent", "model:agent/cli_x", "1.00"],
      [second, "client:initech", "agent", "model:agent/cli_x", "1.00"],
    ]);
    expect(lines[0]?.split("\t").slice(6)).toEqual(["-", made.objectId, "Plan Q3 .docx"]);
    // Someone who can't tag the file sees none of it, and can't decide it.
    const others = await review("list", "--user", made.holder);
    expect(others).toMatchObject({ code: 0, out: "" });
    expect(others.err).toContain("Nothing waits");
    const refused = await review("approve", "--user", made.holder, "--id", first);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("no open review item");
    expect(await reads(made.holder)).toBe(false);
    // The seeded reader reads the file and may not tag it.
    const reader = await review("approve", "--user", "ana-7@example.com", "--id", first);
    expect(reader.code).toBe(1);
    expect(reader.err).toContain("may not tag that file");

    const approved = await review("approve", "--user", made.editor, "--id", first);
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toBe(`${first}\n`);
    expect(approved.err).toContain("Approved client:globex");
    // The grant the tag implies now gives the file.
    expect(await reads(made.holder)).toBe(true);

    const merged = await review("merge", "--user", made.editor, "--id", second, "--into", "globex");
    expect(merged.code, merged.err).toBe(0);
    const tags = await inspect((db) =>
      db.withTenant(tenantId, (tx) => tx.select().from(objectTags)),
    );
    expect(tags.map((r) => [r.value, r.reviewed]).sort()).toEqual([
      ["acme-7", false],
      ["globex", true],
    ]);
    const empty = await review("list", "--user", made.editor);
    expect(empty.out).toBe("");
    expect(empty.err).toContain("Nothing waits");

    // A value the vocabulary doesn't have is a tenant admin's to approve: the editor isn't one
    // until the operator makes them one.
    const fresh = await inspect((db) =>
      db.withTenant(tenantId, async (tx) => {
        const out = await proposeTag(tx, tenantId, {
          objectId: made.objectId,
          tag: "client:newco",
          source: "model",
          appliedBy: "model:test/m",
          confidence: 0.9,
        });
        if (out.applied) throw new Error("applied");
        return out.reviewId;
      }),
    );
    expect((await review("list", "--user", made.editor)).out.split("\t")[6]).toBe("admin");
    const notAdmin = await review("approve", "--user", made.editor, "--id", fresh);
    expect(notAdmin.code).toBe(1);
    expect(notAdmin.err).toContain("isn't a tenant admin");
    expect(
      (await admin("user", "grant-admin", "--tenant", tenantId, "--user", made.editor)).code,
    ).toBe(0);
    const asAdmin = await review("approve", "--user", made.editor, "--id", fresh);
    expect(asAdmin.code, asAdmin.err).toBe(0);

    // Decided already, and misuse.
    const again = await review("reject", "--user", made.editor, "--id", first);
    expect(again.code).toBe(1);
    expect((await review("approve", "--user", made.editor, "--id", "nope")).code).toBe(2);
    expect((await review("approve", "--id", first)).code).toBe(2);
    expect((await review("reject", "--user", made.editor, "--id", first, "--replace")).code).toBe(
      2,
    );
    expect((await review("merge", "--user", made.editor, "--id", first)).code).toBe(2);
    expect((await review("list", "--user", made.editor, "--limit", "0")).code).toBe(2);
    expect((await review("list", "--user", "nobody@example.com")).code).toBe(1);
    expect((await review("reject", "--user", "nobody@example.com", "--id", first)).code).toBe(1);

    const events = await inspect(async (db) => {
      const out: string[] = [];
      await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void out.push(s));
      return out
        .join("")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              actor: string;
              action: string;
              decision: string;
              object?: string;
              detail?: Record<string, unknown>;
            },
        )
        .filter((e) => e.action === "tag.review");
    });
    expect(events.every((e) => e.actor === ADMIN_ACTOR)).toBe(true);
    expect(
      events.map((e) => [e.decision, e.detail?.review, e.detail?.refusal ?? e.detail?.outcome]),
    ).toEqual([
      ["deny", first, "not-found"],
      ["deny", first, "refused"],
      ["allow", first, "approved"],
      ["allow", second, "merged"],
      ["deny", fresh, "not-admin"],
      ["allow", fresh, "approved"],
      ["deny", first, "not-found"],
      ["deny", first, "unknown-user"],
    ]);
    // A refusal names the file it was about, for the record only.
    expect(events.slice(0, 2).map((e) => e.object)).toEqual([made.objectId, made.objectId]);
    expect(events[3]?.detail).toMatchObject({ into: "client:globex", reason: "agent" });
    expect(events[2]?.detail).toMatchObject({
      outcome: "approved",
      reviewer: `user:${made.editor}`,
    });
  });
});
