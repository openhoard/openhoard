import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/*
 * WebAuthn, the relying party's checks (T-108): what a browser returns when a passkey is made
 * (a registration) and when it signs in (an assertion), verified as the specification's
 * sections 7.1 and 7.2 say. No database, no clock: pure functions over bytes.
 *
 * Deliberately narrow:
 *
 * - No attestation. The server asks for none (`attestation: "none"`), and whatever statement
 *   arrives is not verified: OpenHoard learns that a key pair was made, never which make of
 *   authenticator made it. So no certificate chains, no metadata service, no X.509.
 * - Three signature algorithms, the ones passkeys use: ES256 (P-256), EdDSA (Ed25519) and RS256.
 *   node:crypto imports the key (and checks the point is on the curve) and verifies.
 * - The person is always verified (the UV flag): a passkey replaces a password and a second
 *   factor at once, so presence alone is refused.
 * - CBOR is decoded by a strict reader for the subset CTAP2 emits: definite lengths, integer or
 *   text map keys, no duplicates, no floats or tags, shallow nesting.
 *
 * Every failure is a WebAuthnError with a short code, for the audit; none of them says more to
 * the browser than "failed".
 */

export type WebAuthnErrorCode =
  | "malformed"
  | "type"
  | "challenge"
  | "origin"
  | "rp-id"
  | "user-presence"
  | "user-verification"
  | "backup-state"
  | "algorithm"
  | "key"
  | "signature"
  | "counter";

export class WebAuthnError extends Error {
  constructor(
    readonly code: WebAuthnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebAuthnError";
  }
}

const fail = (code: WebAuthnErrorCode, message: string): never => {
  throw new WebAuthnError(code, message);
};

/** COSE algorithm identifiers accepted, in the order offered to the authenticator. */
export const PASSKEY_ALGORITHMS = [-8, -7, -257] as const;
export type PasskeyAlgorithm = (typeof PASSKEY_ALGORITHMS)[number];

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Bytes from unpadded base64url, or a `malformed` error: Buffer.from() alone accepts anything. */
export function fromBase64Url(text: unknown, what: string, maxBytes: number): Buffer {
  if (typeof text !== "string" || !BASE64URL.test(text) || text.length % 4 === 1) {
    return fail("malformed", `${what} is not base64url`);
  }
  if (text.length > Math.ceil((maxBytes * 4) / 3)) return fail("malformed", `${what} is too long`);
  const bytes = Buffer.from(text, "base64url");
  // Canonical only: the same bytes never arrive under two spellings.
  if (bytes.toString("base64url") !== text) return fail("malformed", `${what} is not canonical`);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// CBOR (RFC 8949), the subset CTAP2 uses

export type Cbor =
  number | string | boolean | null | Uint8Array | Cbor[] | Map<number | string, Cbor>;

const MAX_DEPTH = 6;
const MAX_ITEMS = 64;

/**
 * Decodes one CBOR item starting at `offset`; returns it and where it ends. Refuses indefinite
 * lengths, tags, floats, non-minimal integers, map keys other than integers and text, duplicate
 * keys, and anything past 2^53.
 */
export function decodeCbor(bytes: Uint8Array, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > MAX_DEPTH) return fail("malformed", "CBOR nested too deep");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => {
    if (offset + n > bytes.byteLength) fail("malformed", "CBOR ends early");
  };
  need(1);
  const initial = view.getUint8(offset);
  const major = initial >> 5;
  const info = initial & 0x1f;
  offset += 1;
  let arg: number;
  if (info < 24) {
    arg = info;
  } else if (info === 24) {
    need(1);
    arg = view.getUint8(offset);
    offset += 1;
    if (arg < 24 && major !== 7) fail("malformed", "CBOR integer not minimal");
  } else if (info === 25) {
    need(2);
    arg = view.getUint16(offset);
    offset += 2;
    if (arg < 0x100) fail("malformed", "CBOR integer not minimal");
  } else if (info === 26) {
    need(4);
    arg = view.getUint32(offset);
    offset += 4;
    if (arg < 0x10000) fail("malformed", "CBOR integer not minimal");
  } else if (info === 27) {
    need(8);
    const big = view.getBigUint64(offset);
    offset += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail("malformed", "CBOR integer too large");
    arg = Number(big);
    if (arg < 0x100000000) fail("malformed", "CBOR integer not minimal");
  } else {
    return fail("malformed", "CBOR indefinite lengths are not accepted");
  }
  switch (major) {
    case 0:
      return { value: arg, end: offset };
    case 1:
      return { value: -1 - arg, end: offset };
    case 2:
    case 3: {
      need(arg);
      const slice = bytes.subarray(offset, offset + arg);
      if (major === 2) return { value: slice, end: offset + arg };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
      } catch {
        return fail("malformed", "CBOR text is not UTF-8");
      }
      return { value: text, end: offset + arg };
    }
    case 4: {
      if (arg > MAX_ITEMS) return fail("malformed", "CBOR array too long");
      const items: Cbor[] = [];
      for (let i = 0; i < arg; i++) {
        const item = decodeCbor(bytes, offset, depth + 1);
        items.push(item.value);
        offset = item.end;
      }
      return { value: items, end: offset };
    }
    case 5: {
      if (arg > MAX_ITEMS) return fail("malformed", "CBOR map too large");
      const map = new Map<number | string, Cbor>();
      for (let i = 0; i < arg; i++) {
        const key = decodeCbor(bytes, offset, depth + 1);
        if (typeof key.value !== "number" && typeof key.value !== "string") {
          return fail("malformed", "CBOR map key is neither an integer nor text");
        }
        if (map.has(key.value)) return fail("malformed", "CBOR map has a duplicate key");
        const item = decodeCbor(bytes, key.end, depth + 1);
        map.set(key.value, item.value);
        offset = item.end;
      }
      return { value: map, end: offset };
    }
    case 7:
      if (info === 20) return { value: false, end: offset };
      if (info === 21) return { value: true, end: offset };
      if (info === 22) return { value: null, end: offset };
      return fail("malformed", "CBOR floats and simple values are not accepted");
    default:
      return fail("malformed", "CBOR tags are not accepted");
  }
}

// ---------------------------------------------------------------------------------------------
// COSE keys (RFC 9052, 9053)

/** Longest COSE key kept: an 8,192-bit RSA key is under 1,100 bytes. */
export const MAX_COSE_KEY_BYTES = 1200;

/**
 * Ed25519 points of small order (as libsodium lists them, sign bit cleared): a "key" that is
 * one of these verifies signatures anyone can make.
 */
const ED25519_SMALL_ORDER = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]);

/**
 * A credential's public key from its COSE form: one of PASSKEY_ALGORITHMS, with exactly the
 * parameters that algorithm has and no others (no private part, no padding to fill a column).
 * node:crypto refuses a point that isn't on its curve; degenerate keys it would take (an RSA
 * exponent below 65,537 or even, an even modulus, a small-order Ed25519 point) are refused here.
 */
export function importCoseKey(cose: Uint8Array): { key: KeyObject; algorithm: PasskeyAlgorithm } {
  if (cose.byteLength > MAX_COSE_KEY_BYTES) return fail("key", "the public key is too large");
  const decoded = decodeCbor(cose);
  if (decoded.end !== cose.byteLength) return fail("key", "bytes after the public key");
  const map = decoded.value;
  if (!(map instanceof Map)) return fail("key", "the public key is not a COSE map");
  const only = (...labels: number[]) => {
    if (map.size !== labels.length || labels.some((l) => !map.has(l))) {
      fail("key", "the public key has parameters its algorithm doesn't");
    }
  };
  const bytesOf = (label: number, what: string, min: number, max: number): Buffer => {
    const v = map.get(label);
    if (!(v instanceof Uint8Array) || v.byteLength < min || v.byteLength > max) {
      return fail("key", `the public key's ${what} is missing or the wrong size`);
    }
    return Buffer.from(v);
  };
  const kty = map.get(1);
  const alg = map.get(3);
  const b64 = (b: Buffer) => b.toString("base64url");
  let jwk: Record<string, string>;
  if (alg === -7) {
    // EC2 (kty 2), curve P-256 (crv 1).
    if (kty !== 2 || map.get(-1) !== 1) return fail("key", "ES256 needs a P-256 key");
    only(1, 3, -1, -2, -3);
    jwk = {
      kty: "EC",
      crv: "P-256",
      x: b64(bytesOf(-2, "x", 32, 32)),
      y: b64(bytesOf(-3, "y", 32, 32)),
    };
  } else if (alg === -8) {
    // OKP (kty 1), curve Ed25519 (crv 6).
    if (kty !== 1 || map.get(-1) !== 6) return fail("key", "EdDSA needs an Ed25519 key");
    only(1, 3, -1, -2);
    const x = bytesOf(-2, "x", 32, 32);
    const unsigned = Buffer.from(x);
    unsigned[31] = (unsigned[31] as number) & 0x7f;
    if (ED25519_SMALL_ORDER.has(unsigned.toString("hex"))) {
      return fail("key", "the Ed25519 key is a small-order point");
    }
    jwk = { kty: "OKP", crv: "Ed25519", x: b64(x) };
  } else if (alg === -257) {
    // RSA (kty 3): 2,048 to 8,192 bits.
    if (kty !== 3) return fail("key", "RS256 needs an RSA key");
    only(1, 3, -1, -2);
    const n = bytesOf(-1, "modulus", 256, 1024);
    if (n[0] === 0 || ((n[n.length - 1] as number) & 1) === 0) {
      return fail("key", "the RSA modulus has a leading zero or is even");
    }
    // With a tiny exponent a "signature" needs no private key (e = 1 verifies anything padded).
    const e = bytesOf(-2, "exponent", 3, 8);
    const exponent = BigInt(`0x${e.toString("hex")}`);
    if (e[0] === 0 || exponent < 65537n || exponent % 2n === 0n) {
      return fail("key", "the RSA exponent must be odd and at least 65,537");
    }
    jwk = { kty: "RSA", n: b64(n), e: b64(e) };
  } else {
    return fail("algorithm", "the credential's algorithm is not one OpenHoard accepts");
  }
  try {
    return { key: createPublicKey({ key: jwk, format: "jwk" }), algorithm: alg };
  } catch {
    return fail("key", "the public key is not a valid key");
  }
}

// ---------------------------------------------------------------------------------------------
// Client data and authenticator data

export interface Expected {
  /** The challenge the server issued, base64url, as the browser must echo it. */
  challenge: string;
  /** The server's origin (`https://files.example.com`), exactly. */
  origin: string;
  /** The relying party id: the origin's host. */
  rpId: string;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** Checks the client data (what the browser says it was asked); returns its hash. */
function checkClientData(
  raw: Buffer,
  type: "webauthn.create" | "webauthn.get",
  expected: Expected,
): Buffer {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return fail("malformed", "the client data is not JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail("malformed", "the client data is not an object");
  }
  const c = data as Record<string, unknown>;
  if (c.type !== type) return fail("type", `the client data is not for ${type}`);
  if (
    typeof c.challenge !== "string" ||
    !sameBytes(Buffer.from(c.challenge), Buffer.from(expected.challenge))
  ) {
    return fail("challenge", "the challenge is not the one issued");
  }
  if (c.origin !== expected.origin) return fail("origin", "the request came from another origin");
  // A page of ours framed by another site is not this person choosing to sign in here.
  if (c.crossOrigin !== undefined && c.crossOrigin !== false) {
    return fail("origin", "the request came from a cross-origin frame");
  }
  return sha256(raw);
}

const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

interface AuthenticatorData {
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
  credential?: { aaguid: string; id: Buffer; publicKey: Buffer };
}

function parseAuthenticatorData(data: Buffer, expected: Expected): AuthenticatorData {
  if (data.byteLength < 37) return fail("malformed", "the authenticator data is too short");
  if (!sameBytes(data.subarray(0, 32), sha256(Buffer.from(expected.rpId)))) {
    return fail("rp-id", "the credential is for another site");
  }
  const flags = data[32] as number;
  if (!(flags & FLAG.UP)) return fail("user-presence", "the person was not present");
  if (!(flags & FLAG.UV)) return fail("user-verification", "the person was not verified");
  const backupEligible = (flags & FLAG.BE) !== 0;
  const backedUp = (flags & FLAG.BS) !== 0;
  if (backedUp && !backupEligible) {
    return fail("backup-state", "backed up, yet not eligible for backup");
  }
  const out: AuthenticatorData = { signCount: data.readUInt32BE(33), backupEligible, backedUp };
  let offset = 37;
  if (flags & FLAG.AT) {
    if (data.byteLength < offset + 18) return fail("malformed", "the credential data is cut off");
    const aaguid = data.subarray(offset, offset + 16).toString("hex");
    const idLength = data.readUInt16BE(offset + 16);
    offset += 18;
    if (idLength < 16 || idLength > 1023 || data.byteLength < offset + idLength) {
      return fail("malformed", "the credential id is 16 to 1,023 bytes");
    }
    const id = data.subarray(offset, offset + idLength);
    offset += idLength;
    const key = decodeCbor(data, offset);
    out.credential = { aaguid, id, publicKey: data.subarray(offset, key.end) };
    offset = key.end;
  }
  if (flags & FLAG.ED) {
    const extensions = decodeCbor(data, offset);
    if (!(extensions.value instanceof Map)) return fail("malformed", "extensions are not a map");
    offset = extensions.end;
  }
  if (offset !== data.byteLength) return fail("malformed", "bytes after the authenticator data");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Registration (WebAuthn 7.1)

/** What `PublicKeyCredential.toJSON()` gives for a new credential (the parts read here). */
export interface RegistrationResponse {
  response: { clientDataJSON: string; attestationObject: string; transports?: unknown };
}

export interface RegisteredCredential {
  /** base64url. */
  credentialId: string;
  /** The COSE key, base64url. */
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
  aaguid: string;
  transports: string[];
}

const TRANSPORT = /^[a-z][a-z0-9-]{0,31}$/;

/** Checks a new credential against what the server asked for; returns what to keep of it. */
export function verifyRegistration(
  credential: RegistrationResponse,
  expected: Expected,
): RegisteredCredential {
  const r = (credential as { response?: unknown } | null)?.response;
  if (typeof r !== "object" || r === null) return fail("malformed", "no response");
  const response = r as RegistrationResponse["response"];
  checkClientData(
    fromBase64Url(response.clientDataJSON, "clientDataJSON", 4096),
    "webauthn.create",
    expected,
  );
  const attestation = fromBase64Url(response.attestationObject, "attestationObject", 16384);
  const decoded = decodeCbor(attestation);
  if (decoded.end !== attestation.byteLength || !(decoded.value instanceof Map)) {
    return fail("malformed", "the attestation object is not one CBOR map");
  }
  const fmt = decoded.value.get("fmt");
  const statement = decoded.value.get("attStmt");
  const authData = decoded.value.get("authData");
  if (typeof fmt !== "string" || !(statement instanceof Map) || !(authData instanceof Uint8Array)) {
    return fail("malformed", "the attestation object lacks fmt, attStmt or authData");
  }
  // None was asked for. A statement that comes anyway is not verified, and claims nothing here.
  if (fmt === "none" && statement.size > 0) {
    return fail("malformed", "a `none` attestation carries a statement");
  }
  const data = parseAuthenticatorData(Buffer.from(authData), expected);
  if (!data.credential) return fail("malformed", "no credential in the authenticator data");
  const { algorithm } = importCoseKey(data.credential.publicKey);
  const transports = Array.isArray(response.transports)
    ? [
        ...new Set(
          response.transports.filter(
            (t): t is string => typeof t === "string" && TRANSPORT.test(t),
          ),
        ),
      ].slice(0, 8)
    : [];
  return {
    credentialId: data.credential.id.toString("base64url"),
    publicKey: data.credential.publicKey.toString("base64url"),
    algorithm,
    signCount: data.signCount,
    backupEligible: data.backupEligible,
    backedUp: data.backedUp,
    aaguid: data.credential.aaguid,
    transports,
  };
}

// ---------------------------------------------------------------------------------------------
// Authentication (WebAuthn 7.2)

/** What `PublicKeyCredential.toJSON()` gives for an assertion (the parts read here). */
export interface AuthenticationResponse {
  id: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
}

/** What the server kept of the credential an assertion names. */
export interface StoredCredential {
  publicKey: string;
  algorithm: number;
  signCount: number;
  backupEligible: boolean;
}

/**
 * Checks an assertion against the stored credential; returns the counter and backup state to
 * record. The caller has matched `id` (and the user handle) to the stored credential.
 */
export function verifyAuthentication(
  assertion: AuthenticationResponse,
  stored: StoredCredential,
  expected: Expected,
): { signCount: number; backedUp: boolean } {
  const r = (assertion as { response?: unknown } | null)?.response;
  if (typeof r !== "object" || r === null) return fail("malformed", "no response");
  const response = r as AuthenticationResponse["response"];
  const clientData = fromBase64Url(response.clientDataJSON, "clientDataJSON", 4096);
  const clientHash = checkClientData(clientData, "webauthn.get", expected);
  const authData = fromBase64Url(response.authenticatorData, "authenticatorData", 4096);
  const signature = fromBase64Url(response.signature, "signature", 2048);
  const data = parseAuthenticatorData(authData, expected);
  if (data.credential) return fail("malformed", "an assertion carries no credential data");
  // Whether a credential may be synced is fixed when it is made.
  if (data.backupEligible !== stored.backupEligible) {
    return fail("backup-state", "the credential's backup eligibility changed");
  }
  const { key, algorithm } = importCoseKey(
    fromBase64Url(stored.publicKey, "publicKey", MAX_COSE_KEY_BYTES),
  );
  if (algorithm !== stored.algorithm) return fail("algorithm", "the stored algorithm differs");
  const signed = Buffer.concat([authData, clientHash]);
  let good: boolean;
  try {
    good =
      algorithm === -8
        ? verify(null, signed, key, signature)
        : algorithm === -7
          ? verify("sha256", signed, { key, dsaEncoding: "der" }, signature)
          : verify("sha256", signed, key, signature);
  } catch {
    good = false;
  }
  if (!good) return fail("signature", "the signature does not verify");
  // A counter that doesn't advance means two authenticators hold the key: a copy. Passkeys that
  // sync keep none (always 0), which says nothing either way.
  if ((data.signCount !== 0 || stored.signCount !== 0) && data.signCount <= stored.signCount) {
    return fail("counter", "the signature counter did not advance");
  }
  return { signCount: data.signCount, backedUp: data.backedUp };
}
