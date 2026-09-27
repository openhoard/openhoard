import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isId } from "@openhoard/core-db";

/*
 * Each tenant's 32-byte blob key (ADR-0013, core/catalog scopedBlobId()): blob ids are keyed by
 * it, so the database alone can't tell that two tenants hold the same file, or that a tenant
 * holds a known one. The key is kept outside the database, in the data directory:
 * `<dataDir>/keys/<tenant id>.blob-key`, 32 random bytes in base64url, made on first use,
 * readable only by the service user (0600 in a 0700 folder on POSIX; on Windows the data
 * directory's ACL, as for the rest of it).
 *
 * The key must never change: blob ids made with it would no longer match their bytes. So it is
 * created exclusively (a second process racing to create it reads the first one's), and a file
 * that isn't a key stops the server rather than being replaced. Back it up with the database.
 * Several servers sharing one database must share these files (a KMS-backed store is for
 * later).
 */

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** The tenant blob keys under `dataDir`, cached once read. */
export function tenantKeyStore(dataDir: string): (tenantId: string) => Uint8Array {
  const dir = join(dataDir, "keys");
  const cache = new Map<string, Uint8Array>();
  return (tenantId) => {
    if (!isId("tenant", tenantId)) throw new TypeError("not a tenant id");
    const known = cache.get(tenantId);
    if (known) return known;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    const file = join(dir, `${tenantId}.blob-key`);
    try {
      writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    const text = readFileSync(file, "utf8").trim();
    if (!KEY_TEXT.test(text)) {
      throw new Error(`${file} is not a tenant key (32 bytes, base64url): restore it from backup`);
    }
    const key = new Uint8Array(Buffer.from(text, "base64url"));
    cache.set(tenantId, key);
    return key;
  };
}
