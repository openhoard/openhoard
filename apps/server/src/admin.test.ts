import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAudit } from "@openhoard/core-audit";
import { openDatabase, type Database } from "@openhoard/core-db";
import { openTestDatabase, TEST_POSTGRES_ENV } from "@openhoard/core-db/testing";
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
    ...(shared ? { open: async () => ({ ...(shared as Database), close: async () => {} }) } : {}),
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
