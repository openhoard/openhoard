import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobs, isId, type Database } from "@openhoard/core-db";
import { eq } from "drizzle-orm";

/*
 * Each tenant's 32-byte blob key (ADR-0013, core/catalog scopedBlobId()): blob ids are keyed by
 * it, so the database alone can't tell that two tenants hold the same file, or that a tenant
 * holds a known one. The key is kept outside the database, in the data directory:
 * `<dataDir>/keys/<tenant id>.blob-key`, 32 random bytes in base64url, readable only by the
 * service user (0600 in a 0700 folder on POSIX; on Windows the data directory's ACL, as for the
 * rest of it).
 *
 * The key must never change: blob ids made with it would no longer match their bytes. So:
 *
 * - it is made only for a tenant that has no content yet (no blob); a tenant with content and
 *   no key file means the file was lost, and the server stops, pointing at the backup, rather
 *   than make a new key under blobs recorded with the old one;
 * - it is written whole to a file of its own, then linked into place, which fails when the key
 *   exists (another process made it first: that one is read). A key file is never partial or
 *   empty, and never replaced; one that isn't a key stops the server.
 *
 * Back it up with the database. Several servers sharing one database must share these files (a
 * KMS-backed store is for later).
 */

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

export interface TenantKeyOptions {
  /** Whether the tenant has content already (a blob): then a missing key is lost, not new. */
  hasContent: (tenantId: string) => Promise<boolean>;
}

/** Whether the tenant has any blob, from the database. */
export const blobsIn =
  (db: Database) =>
  (tenantId: string): Promise<boolean> =>
    db.withTenant(
      tenantId,
      async (tx) =>
        (await tx.select({ id: blobs.id }).from(blobs).where(eq(blobs.tenantId, tenantId)).limit(1))
          .length > 0,
      { accessMode: "read only" },
    );

/** The tenant blob keys under `dataDir`, cached once read. */
export function tenantKeyStore(
  dataDir: string,
  options: TenantKeyOptions,
): (tenantId: string) => Promise<Uint8Array> {
  const dir = join(dataDir, "keys");
  const cache = new Map<string, Uint8Array>();
  const read = (file: string): string | null => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
  };
  return async (tenantId) => {
    if (!isId("tenant", tenantId)) throw new TypeError("not a tenant id");
    const known = cache.get(tenantId);
    if (known) return known;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    const file = join(dir, `${tenantId}.blob-key`);
    let text = read(file);
    if (text === null) {
      if (await options.hasContent(tenantId)) {
        throw new Error(
          `${file} is missing, but tenant ${tenantId} has content recorded with its key: ` +
            `restore the file from the data directory's backup (a new key would not match)`,
        );
      }
      const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(temp, `${randomBytes(32).toString("base64url")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        linkSync(temp, file);
      } catch (e) {
        // Another process linked its key first: that one stands.
        if ((e as { code?: string }).code !== "EEXIST") throw e;
      } finally {
        unlinkSync(temp);
      }
      text = read(file);
    }
    if (text === null || !KEY_TEXT.test(text)) {
      throw new Error(`${file} is not a tenant key (32 bytes, base64url): restore it from backup`);
    }
    const key = new Uint8Array(Buffer.from(text, "base64url"));
    cache.set(tenantId, key);
    return key;
  };
}
