import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/*
 * A sign-in under way (T-102): its PKCE verifier, nonce and return path, sealed with AES-256-GCM
 * into a cookie of its own. Starting a sign-in writes nothing on the server, so nobody can fill
 * a table (or a tenant's quota) by starting sign-ins. The cookie is HttpOnly, bound to the
 * callback path, named after its state, and expires in minutes; the provider refuses a code used
 * twice, and the nonce ties the ID token to this sign-in.
 */

export interface LoginState {
  provider: string;
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

const AAD = Buffer.from("openhoard/login/v1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A 32-byte key from base64url (auth.cookieKey), or a new random one. */
export function loginKey(configured?: string): Buffer {
  if (configured === undefined) return randomBytes(32);
  const key = Buffer.from(configured, "base64url");
  if (key.length !== 32) throw new Error("auth.cookieKey must be 32 bytes, base64url");
  return key;
}

/** The cookie's name for a state: a tag of its hash, so two sign-ins don't share one. */
export function loginCookieName(state: string, secure: boolean): string {
  const tag = createHash("sha256").update(state).digest("hex").slice(0, 16);
  return `${secure ? "__Secure-" : ""}oh_login_${tag}`;
}

export function sealLogin(key: Buffer, login: LoginState): string {
  return seal(key, AAD, login);
}

/**
 * Seals a value for `purpose` (AES-256-GCM, the purpose as associated data): what one purpose
 * sealed never opens as another's.
 */
export function seal(key: Buffer, purpose: Buffer | string, value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(typeof purpose === "string" ? Buffer.from(purpose) : purpose);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** What seal() sealed for `purpose`, parsed; null if it wasn't, or it is malformed. */
export function unseal(key: Buffer, purpose: Buffer | string, sealed: string): unknown {
  if (typeof sealed !== "string" || sealed.length > 16384) return null;
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(typeof purpose === "string" ? Buffer.from(purpose) : purpose);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const text = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The sign-in a cookie holds, or null if it isn't one this key sealed, or it is malformed. */
export function openLogin(key: Buffer, sealed: string): LoginState | null {
  const v = unseal(key, AAD, sealed) as Partial<LoginState> | null;
  if (typeof v !== "object" || v === null) return null;
  const str = (x: unknown): x is string => typeof x === "string";
  if (
    !str(v.provider) ||
    !str(v.state) ||
    !str(v.codeVerifier) ||
    !str(v.nonce) ||
    !str(v.returnTo) ||
    typeof v.expiresAt !== "number"
  ) {
    return null;
  }
  return v as LoginState;
}
