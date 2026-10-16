import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * A tenant's storage key, sealed for the database (tenant_storage.secret): AES-256-GCM under the
 * server's storage key (kept in the data directory, never in the database), with what it is for
 * (the tenant and the kind of storage) as associated data, so a sealed key copied to another
 * tenant's row, or to another kind, doesn't open.
 *
 * Sealed text: `v1.<12-byte nonce>.<ciphertext and 16-byte tag>`, base64url.
 */

const VERSION = "v1";
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,2048})$/;

/** Thrown when a sealed key doesn't open: another server key, or text changed in the database. */
export class SealedSecretError extends Error {
  constructor() {
    super("the stored storage key can't be read with this server's storage key");
    this.name = "SealedSecretError";
  }
}

function checkKey(key: Uint8Array): void {
  if (key.byteLength !== 32) throw new RangeError("the storage key must be 32 bytes");
}

/** `secret`, sealed under `key` for `context` (the tenant and kind). */
export function sealSecret(key: Uint8Array, context: string, secret: string): string {
  checkKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const sealed = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${nonce.toString("base64url")}.${sealed.toString("base64url")}`;
}

/** The secret `sealed` holds, for `context`; SealedSecretError if it doesn't open. */
export function openSecret(key: Uint8Array, context: string, sealed: string): string {
  checkKey(key);
  const m = SEALED.exec(sealed);
  if (!m) throw new SealedSecretError();
  const nonce = Buffer.from(m[1] as string, "base64url");
  const body = Buffer.from(m[2] as string, "base64url");
  if (nonce.byteLength !== 12 || body.byteLength < 17) throw new SealedSecretError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(body.subarray(body.byteLength - 16));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.byteLength - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SealedSecretError();
  }
}
