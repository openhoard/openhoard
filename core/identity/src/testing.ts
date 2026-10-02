import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/*
 * A software authenticator for tests: what a browser and a passkey provider do between them,
 * enough to register a credential and sign assertions against the options core/identity's
 * passkeys.ts hands out. Every field a relying party must check can be bent (`Bend`), so the
 * tests show each check refusing.
 *
 *   import { SoftAuthenticator } from "@openhoard/core-identity/testing";
 *
 * Not for production code: it keeps private keys in memory and verifies nothing.
 */

type CborIn = number | string | Uint8Array | Map<number | string, CborIn>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Encodes the CBOR an authenticator emits: integers, byte and text strings, maps. */
export function encodeCbor(value: CborIn): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [k, v] of value) parts.push(encodeCbor(k), encodeCbor(v));
  return Buffer.concat(parts);
}

export type SoftAlgorithm = -7 | -8 | -257;

function newKey(algorithm: SoftAlgorithm): { privateKey: KeyObject; cose: Buffer } {
  const pair =
    algorithm === -7
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : algorithm === -8
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const b = (s: string | undefined) => Buffer.from(s ?? "", "base64url");
  const cose = new Map<number, CborIn>();
  if (algorithm === -7) {
    cose.set(1, 2).set(3, -7).set(-1, 1).set(-2, b(jwk.x)).set(-3, b(jwk.y));
  } else if (algorithm === -8) {
    cose.set(1, 1).set(3, -8).set(-1, 6).set(-2, b(jwk.x));
  } else {
    cose.set(1, 3).set(3, -257).set(-1, b(jwk.n)).set(-2, b(jwk.e));
  }
  return { privateKey: pair.privateKey, cose: encodeCbor(cose) };
}

/** What a test may bend in the next ceremony. Each default is what a real authenticator does. */
export interface Bend {
  /** The origin the "browser" reports (default: the one passed in). */
  origin?: string;
  /** The client data's type. */
  type?: string;
  /** The challenge the "browser" echoes. */
  challenge?: string;
  /** The relying party id hashed into the authenticator data. */
  rpId?: string;
  crossOrigin?: boolean;
  userPresent?: boolean;
  userVerified?: boolean;
  backupEligible?: boolean;
  backedUp?: boolean;
  /** The signature counter to report (default: the next one, or 0 without a counter). */
  signCount?: number;
  /** Sign with another key (an assertion from someone who doesn't hold the passkey). */
  wrongKey?: boolean;
  /** Replaces the COSE public key in a registration. */
  publicKey?: Buffer;
  /** Bytes appended to the authenticator data. */
  trailing?: Buffer;
  /** Authenticator extension outputs: sets the ED flag and appends them. */
  extensions?: Map<number | string, CborIn>;
  /** Flag bits OR-ed in as they are (the reserved bits 0x02 and 0x20, say). */
  flags?: number;
  /** The attestation format and statement (default `none`, empty). */
  fmt?: string;
  attStmt?: Map<number | string, CborIn>;
  /** The user handle an assertion returns (default: the credential's). */
  userHandle?: string | null;
}

interface Held {
  privateKey: KeyObject;
  algorithm: SoftAlgorithm;
  rpId: string;
  userHandle: string;
  signCount: number;
}

export interface SoftRegistration {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  clientExtensionResults: Record<string, never>;
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

export interface SoftAssertion {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credentials = new Map<string, Held>();
  constructor(
    private readonly traits: {
      algorithm?: SoftAlgorithm;
      /** Whether it keeps a signature counter (a hardware key does; a synced passkey doesn't). */
      counter?: boolean;
      backupEligible?: boolean;
      backedUp?: boolean;
    } = {},
  ) {}

  private authData(rpId: string, bend: Bend, signCount: number, attested?: Buffer): Buffer {
    const eligible = bend.backupEligible ?? this.traits.backupEligible ?? true;
    const backedUp = bend.backedUp ?? this.traits.backedUp ?? eligible;
    const flags =
      ((bend.userPresent ?? true) ? 0x01 : 0) |
      ((bend.userVerified ?? true) ? 0x04 : 0) |
      (eligible ? 0x08 : 0) |
      (backedUp ? 0x10 : 0) |
      (attested ? 0x40 : 0) |
      (bend.extensions ? 0x80 : 0) |
      (bend.flags ?? 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(bend.signCount ?? signCount);
    return Buffer.concat([
      sha256(bend.rpId ?? rpId),
      Buffer.from([flags]),
      count,
      attested ?? Buffer.alloc(0),
      bend.extensions ? encodeCbor(bend.extensions) : Buffer.alloc(0),
      bend.trailing ?? Buffer.alloc(0),
    ]);
  }

  private clientData(type: string, challenge: string, origin: string, bend: Bend): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: bend.type ?? type,
        challenge: bend.challenge ?? challenge,
        origin: bend.origin ?? origin,
        crossOrigin: bend.crossOrigin ?? false,
      }),
    );
  }

  /** `navigator.credentials.create()` on `origin`, for the options the server returned. */
  create(options: Record<string, unknown>, origin: string, bend: Bend = {}): SoftRegistration {
    const rp = options.rp as { id: string };
    const user = options.user as { id: string };
    const offered = (options.pubKeyCredParams as { alg: number }[]).map((p) => p.alg);
    const algorithm = this.traits.algorithm ?? -7;
    if (!offered.includes(algorithm)) throw new Error(`the server doesn't offer ${algorithm}`);
    const excluded = (options.excludeCredentials as { id: string }[] | undefined) ?? [];
    if (excluded.some((c) => this.credentials.has(c.id))) {
      throw new DOMException("this authenticator holds a passkey already", "InvalidStateError");
    }
    const { privateKey, cose } = newKey(algorithm);
    const id = randomBytes(32);
    const signCount = this.traits.counter ? 1 : 0;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, id, bend.publicKey ?? cose]);
    const authData = this.authData(rp.id, bend, signCount, attested);
    const attestationObject = encodeCbor(
      new Map<string, CborIn>([
        ["fmt", bend.fmt ?? "none"],
        ["attStmt", bend.attStmt ?? new Map()],
        ["authData", authData],
      ]),
    );
    const credentialId = id.toString("base64url");
    this.credentials.set(credentialId, {
      privateKey,
      algorithm,
      rpId: rp.id,
      userHandle: user.id,
      signCount,
    });
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData(
          "webauthn.create",
          options.challenge as string,
          origin,
          bend,
        ).toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal", "hybrid"],
      },
    };
  }

  /** `navigator.credentials.get()` on `origin`: signs with the (first) passkey for that site. */
  get(
    options: Record<string, unknown>,
    origin: string,
    bend: Bend = {},
    credentialId?: string,
  ): SoftAssertion {
    const rpId = options.rpId as string;
    const id = credentialId ?? [...this.credentials].find(([, held]) => held.rpId === rpId)?.[0];
    const held = id === undefined ? undefined : this.credentials.get(id);
    if (id === undefined || !held) {
      throw new DOMException("no passkey for this site", "NotAllowedError");
    }
    if (this.traits.counter) held.signCount += 1;
    const authData = this.authData(rpId, bend, held.signCount);
    const clientData = this.clientData("webauthn.get", options.challenge as string, origin, bend);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const key = bend.wrongKey ? newKey(held.algorithm).privateKey : held.privateKey;
    const signature = held.algorithm === -8 ? sign(null, signed, key) : sign("sha256", signed, key);
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: bend.userHandle === undefined ? held.userHandle : bend.userHandle,
      },
    };
  }
}
