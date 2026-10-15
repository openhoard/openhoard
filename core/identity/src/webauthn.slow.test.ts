import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeCbor, SoftAuthenticator, type Bend, type SoftAlgorithm } from "./testing.js";
import {
  decodeCbor,
  fromBase64Url,
  importCoseKey,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from "./webauthn.js";

/* The relying party's checks (T-108), against a software authenticator that can bend each field. */

const ORIGIN = "https://files.example.com";
const RP = "files.example.com";
const CHALLENGE = Buffer.alloc(32, 7).toString("base64url");
const expected: Expected = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP };
const creation = {
  rp: { id: RP, name: "OpenHoard" },
  user: { id: Buffer.from("ten_x.usr_y").toString("base64url") },
  challenge: CHALLENGE,
  pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: "public-key", alg })),
};
const request = { rpId: RP, challenge: CHALLENGE };

const code = (work: () => unknown): string => {
  try {
    work();
  } catch (e) {
    if (e instanceof WebAuthnError) return e.code;
    throw e;
  }
  return "accepted";
};

function registered(traits: ConstructorParameters<typeof SoftAuthenticator>[0] = {}) {
  const device = new SoftAuthenticator(traits);
  const made = verifyRegistration(device.create(creation, ORIGIN), expected);
  return { device, made };
}

describe("registration", () => {
  it.each([-7, -8, -257] as SoftAlgorithm[])("accepts a passkey of algorithm %i", (algorithm) => {
    const { device, made } = registered({ algorithm, counter: true });
    expect(made).toMatchObject({
      algorithm,
      signCount: 1,
      backupEligible: true,
      backedUp: true,
      aaguid: "0".repeat(32),
      transports: ["internal", "hybrid"],
    });
    expect([...device.credentials.keys()]).toEqual([made.credentialId]);
    // And what it signs afterwards verifies against what was kept.
    expect(verifyAuthentication(device.get(request, ORIGIN), made, expected)).toEqual({
      signCount: 2,
      backedUp: true,
    });
  });

  const refusals: [string, Bend, string][] = [
    ["another origin", { origin: "https://files.example.com.evil.test" }, "origin"],
    ["a cross-origin frame", { crossOrigin: true }, "origin"],
    ["an assertion's client data", { type: "webauthn.get" }, "type"],
    ["another challenge", { challenge: Buffer.alloc(32, 8).toString("base64url") }, "challenge"],
    ["another site's credential", { rpId: "evil.test" }, "rp-id"],
    ["no user presence", { userPresent: false }, "user-presence"],
    ["no user verification", { userVerified: false }, "user-verification"],
    ["backed up yet not eligible", { backupEligible: false, backedUp: true }, "backup-state"],
    ["bytes after the authenticator data", { trailing: Buffer.from([0]) }, "malformed"],
    ["a `none` attestation with a statement", { attStmt: new Map([["x", 1]]) }, "malformed"],
    [
      "an algorithm not offered",
      {
        publicKey: encodeCbor(
          new Map<number, number | Buffer>([
            [1, 2],
            [3, -35],
          ]),
        ),
      },
      "algorithm",
    ],
    [
      "a point that isn't on the curve",
      {
        publicKey: encodeCbor(
          new Map<number, number | Buffer>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.alloc(32, 1)],
            [-3, Buffer.alloc(32, 2)],
          ]),
        ),
      },
      "key",
    ],
    [
      "a 1,024-bit RSA key",
      {
        publicKey: encodeCbor(
          new Map<number, number | Buffer>([
            [1, 3],
            [3, -257],
            [-1, Buffer.alloc(128, 0xff)],
            [-2, Buffer.from([1, 0, 1])],
          ]),
        ),
      },
      "key",
    ],
  ];
  it.each(refusals)("refuses %s", (_what, bend, why) => {
    expect(
      code(() =>
        verifyRegistration(new SoftAuthenticator().create(creation, ORIGIN, bend), expected),
      ),
    ).toBe(why);
  });

  it("accepts an attestation it didn't ask for, verifying none of it", () => {
    const made = verifyRegistration(
      new SoftAuthenticator().create(creation, ORIGIN, {
        fmt: "packed",
        attStmt: new Map<string, number | Buffer>([
          ["alg", -7],
          ["sig", Buffer.alloc(70)],
        ]),
      }),
      expected,
    );
    expect(made.algorithm).toBe(-7);
  });

  it("refuses what isn't a registration at all", () => {
    const good = new SoftAuthenticator().create(creation, ORIGIN);
    const bad = (response: object) =>
      code(() => verifyRegistration({ response: { ...good.response, ...response } }, expected));
    expect(code(() => verifyRegistration(null as never, expected))).toBe("malformed");
    expect(bad({ clientDataJSON: "not base64url!" })).toBe("malformed");
    expect(bad({ clientDataJSON: Buffer.from("[]").toString("base64url") })).toBe("malformed");
    expect(bad({ clientDataJSON: Buffer.from("{").toString("base64url") })).toBe("malformed");
    expect(bad({ attestationObject: "" })).toBe("malformed");
    expect(bad({ attestationObject: encodeCbor("text").toString("base64url") })).toBe("malformed");
    expect(
      bad({ attestationObject: encodeCbor(new Map([["fmt", "none"]])).toString("base64url") }),
    ).toBe("malformed");
    // Padded or non-canonical base64url is another spelling of the same bytes: refused.
    expect(bad({ clientDataJSON: `${good.response.clientDataJSON}=` })).toBe("malformed");
    // Transports are labels: junk is dropped, never stored.
    const made = verifyRegistration(
      { response: { ...good.response, transports: ["usb", "USB", 7, "usb", "x".repeat(40)] } },
      expected,
    );
    expect(made.transports).toEqual(["usb"]);
  });
});

describe("authentication", () => {
  const refusals: [string, Bend, string][] = [
    ["another origin", { origin: "https://evil.test" }, "origin"],
    ["a cross-origin frame", { crossOrigin: true }, "origin"],
    ["a registration's client data", { type: "webauthn.create" }, "type"],
    ["another challenge", { challenge: Buffer.alloc(32, 9).toString("base64url") }, "challenge"],
    ["another site's assertion", { rpId: "evil.test" }, "rp-id"],
    ["no user presence", { userPresent: false }, "user-presence"],
    ["no user verification", { userVerified: false }, "user-verification"],
    ["a changed backup eligibility", { backupEligible: false, backedUp: false }, "backup-state"],
    ["a signature by another key", { wrongKey: true }, "signature"],
    ["bytes after the authenticator data", { trailing: Buffer.from([0]) }, "malformed"],
  ];
  it.each(refusals)("refuses %s", (_what, bend, why) => {
    const { device, made } = registered();
    expect(
      code(() => verifyAuthentication(device.get(request, ORIGIN, bend), made, expected)),
    ).toBe(why);
  });

  it("refuses a signature over other data, and a truncated one", () => {
    const { device, made } = registered();
    const good = device.get(request, ORIGIN);
    const other = device.get({ ...request, challenge: "AAAA" }, ORIGIN);
    const swap = (response: object) =>
      code(() =>
        verifyAuthentication(
          { ...good, response: { ...good.response, ...response } },
          made,
          expected,
        ),
      );
    expect(swap({})).toBe("accepted");
    expect(swap({ signature: other.response.signature })).toBe("signature");
    expect(swap({ signature: good.response.signature.slice(0, 20) })).toBe("signature");
    expect(swap({ signature: "" })).toBe("signature");
    expect(swap({ authenticatorData: "" })).toBe("malformed");
    // The stored key replaced by another algorithm's: refused before any signature is checked.
    expect(code(() => verifyAuthentication(good, { ...made, algorithm: -8 }, expected))).toBe(
      "algorithm",
    );
  });

  it("refuses a counter that doesn't advance, and accepts authenticators that keep none", () => {
    const { device, made } = registered({ counter: true });
    const stored = { ...made };
    const first = verifyAuthentication(device.get(request, ORIGIN), stored, expected);
    expect(first.signCount).toBe(2);
    stored.signCount = first.signCount;
    // A copy of the authenticator, behind the original: the same count again, or a lower one.
    expect(
      code(() =>
        verifyAuthentication(device.get(request, ORIGIN, { signCount: 2 }), stored, expected),
      ),
    ).toBe("counter");
    expect(
      code(() =>
        verifyAuthentication(device.get(request, ORIGIN, { signCount: 0 }), stored, expected),
      ),
    ).toBe("counter");
    expect(
      verifyAuthentication(device.get(request, ORIGIN, { signCount: 9 }), stored, expected)
        .signCount,
    ).toBe(9);

    const synced = registered();
    expect(synced.made.signCount).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(
        verifyAuthentication(synced.device.get(request, ORIGIN), synced.made, expected).signCount,
      ).toBe(0);
    }
  });

  it("records a passkey that becomes backed up", () => {
    const device = new SoftAuthenticator({ backupEligible: true, backedUp: false });
    const made = verifyRegistration(device.create(creation, ORIGIN), expected);
    expect(made.backedUp).toBe(false);
    expect(
      verifyAuthentication(device.get(request, ORIGIN, { backedUp: true }), made, expected)
        .backedUp,
    ).toBe(true);
  });
});

describe("CBOR and keys", () => {
  const hex = (h: string) => Buffer.from(h.replace(/\s/g, ""), "hex");
  const bad = (h: string) => code(() => decodeCbor(hex(h)));

  it("decodes what an authenticator emits", () => {
    const value = new Map<number | string, number | string | Buffer | Map<number, number>>([
      [1, 2],
      [-1, -257],
      ["fmt", "none"],
      ["big", 65536],
      ["bytes", Buffer.alloc(300, 1)],
      ["map", new Map([[3, 4]])],
    ]);
    const encoded = encodeCbor(value as never);
    const decoded = decodeCbor(encoded);
    expect(decoded.end).toBe(encoded.length);
    const map = decoded.value as Map<number | string, unknown>;
    expect([map.get(1), map.get(-1), map.get("fmt"), map.get("big")]).toEqual([
      2,
      -257,
      "none",
      65536,
    ]);
    expect(Buffer.from(map.get("bytes") as Uint8Array)).toEqual(Buffer.alloc(300, 1));
    expect(decodeCbor(hex("83 f4 f5 f6")).value).toEqual([false, true, null]);
    expect(decodeCbor(hex("1b 0000 0001 0000 0000")).value).toBe(2 ** 32);
  });

  it("refuses everything else", () => {
    expect(bad("")).toBe("malformed"); // nothing
    expect(bad("58")).toBe("malformed"); // a length that isn't there
    expect(bad("44 0102")).toBe("malformed"); // a byte string cut short
    expect(bad("5f ff")).toBe("malformed"); // indefinite length
    expect(bad("18 05")).toBe("malformed"); // 5 in two bytes
    expect(bad("19 00ff")).toBe("malformed");
    expect(bad("1a 0000 ffff")).toBe("malformed");
    expect(bad("1b 0000 0000 ffff ffff")).toBe("malformed");
    expect(bad("1b ffff ffff ffff ffff")).toBe("malformed"); // past 2^53
    expect(bad("c0 00")).toBe("malformed"); // a tag
    expect(bad("f9 3c00")).toBe("malformed"); // a float
    expect(bad("f7")).toBe("malformed"); // undefined
    expect(bad("62 c328")).toBe("malformed"); // text that isn't UTF-8
    expect(bad("a2 01 02 01 03")).toBe("malformed"); // a duplicate key
    expect(bad("a1 41 00 01")).toBe("malformed"); // a byte-string key
    expect(bad("81".repeat(8) + "00")).toBe("malformed"); // nested too deep
    expect(bad("98 41" + "00".repeat(65))).toBe("malformed"); // 65 items
    expect(bad("b8 41")).toBe("malformed"); // a 65-entry map
  });

  it("imports only whole, well-formed keys", () => {
    const key = (entries: [number, number | Buffer][]) =>
      code(() => importCoseKey(encodeCbor(new Map(entries))));
    const x = Buffer.alloc(32, 1);
    expect(code(() => importCoseKey(encodeCbor("text")))).toBe("key");
    expect(
      code(() => importCoseKey(Buffer.concat([encodeCbor(new Map()), Buffer.from([0])]))),
    ).toBe("key");
    expect(
      key([
        [1, 2],
        [3, -7],
        [-1, 2],
        [-2, x],
        [-3, x],
      ]),
    ).toBe("key"); // P-384 named as ES256
    expect(
      key([
        [1, 1],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, x],
      ]),
    ).toBe("key"); // the wrong key type
    expect(
      key([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
      ]),
    ).toBe("key"); // no y
    expect(
      key([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x.subarray(1)],
        [-3, x],
      ]),
    ).toBe("key");
    expect(
      key([
        [1, 1],
        [3, -8],
        [-1, 4],
        [-2, x],
      ]),
    ).toBe("key"); // X25519 isn't a signing key
    expect(
      key([
        [1, 2],
        [3, -257],
        [-1, Buffer.alloc(256, 1)],
        [-2, Buffer.from([3])],
      ]),
    ).toBe("key");
    expect(
      key([
        [1, 3],
        [3, -257],
        [-1, Buffer.alloc(256, 0)],
        [-2, Buffer.from([3])],
      ]),
    ).toBe("key");
    expect(
      key([
        [1, 3],
        [3, -7],
      ]),
    ).toBe("key");
    expect(key([[1, 2]])).toBe("algorithm");
    expect(
      key([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, x],
      ]),
    ).toBe("accepted");
  });

  it("refuses keys that verify what nobody signed, and anything beyond the key itself", () => {
    const key = (entries: [number, number | Buffer][]) =>
      code(() => importCoseKey(encodeCbor(new Map(entries))));
    const jwk = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      format: "jwk",
    });
    const n = Buffer.from(jwk.n ?? "", "base64url");
    const rsa = (e: number[], modulus = n) =>
      key([
        [1, 3],
        [3, -257],
        [-1, modulus],
        [-2, Buffer.from(e)],
      ]);
    expect(rsa([1, 0, 1])).toBe("accepted");
    // e = 1 makes any padded block its own signature; small and even exponents go with it.
    for (const e of [[1], [3], [0, 0, 1], [1, 0, 0], [0, 1, 0, 1], [0xff, 0xff]]) {
      expect(rsa(e)).toBe("key");
    }
    const even = Buffer.from(n);
    even[even.length - 1] = (even[even.length - 1] as number) & 0xfe;
    expect(rsa([1, 0, 1], even)).toBe("key");

    // Ed25519 points of small order, with either sign bit.
    for (const hex of [
      "00".repeat(32),
      `01${"00".repeat(31)}`,
      `00${"00".repeat(30)}80`,
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      `ec${"ff".repeat(30)}7f`,
      `ec${"ff".repeat(30)}ff`,
    ]) {
      expect(
        key([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, Buffer.from(hex, "hex")],
        ]),
      ).toBe("key");
    }

    // A real key with something more in it: a private part, or padding to fill the column.
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
      format: "jwk",
    });
    const point: [number, number | Buffer][] = [
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(ec.x ?? "", "base64url")],
      [-3, Buffer.from(ec.y ?? "", "base64url")],
    ];
    expect(key(point)).toBe("accepted");
    expect(key([...point, [-4, Buffer.alloc(32, 1)]])).toBe("key");
    expect(key([...point, [99, Buffer.alloc(100)]])).toBe("key");
    expect(key([...point, [99, Buffer.alloc(3000)]])).toBe("key");
    // And as a registration: refused there, not when the database is asked to keep it.
    const padded = encodeCbor(
      new Map<number, number | Buffer>([...point, [99, Buffer.alloc(3000)]]),
    );
    expect(
      code(() =>
        verifyRegistration(
          new SoftAuthenticator().create(creation, ORIGIN, { publicKey: padded }),
          expected,
        ),
      ),
    ).toBe("key");
  });

  it("reads authenticator extensions and ignores flag bits that mean nothing yet", () => {
    const device = new SoftAuthenticator();
    const extensions = new Map<string, number>([["credProtect", 2]]);
    const made = verifyRegistration(
      device.create(creation, ORIGIN, { extensions, flags: 0x22 }),
      expected,
    );
    expect(
      verifyAuthentication(device.get(request, ORIGIN, { extensions }), made, expected),
    ).toEqual({ signCount: 0, backedUp: true });
    // The ED flag with nothing behind it, or with something that isn't a map.
    expect(
      code(() =>
        verifyAuthentication(device.get(request, ORIGIN, { flags: 0x80 }), made, expected),
      ),
    ).toBe("malformed");
    expect(
      code(() =>
        verifyAuthentication(
          device.get(request, ORIGIN, { flags: 0x80, trailing: encodeCbor("x") }),
          made,
          expected,
        ),
      ),
    ).toBe("malformed");
    // An assertion never carries credential data (the AT flag).
    expect(
      code(() =>
        verifyAuthentication(device.get(request, ORIGIN, { flags: 0x40 }), made, expected),
      ),
    ).toBe("malformed");
  });

  it("reads only canonical base64url", () => {
    expect(fromBase64Url("AQID", "x", 3)).toEqual(Buffer.from([1, 2, 3]));
    // Padding, the other alphabet, an impossible length, stray bits in the last character.
    for (const text of ["AQID=", "AQ+D", "A", "AB", 7, undefined]) {
      expect(code(() => fromBase64Url(text, "x", 3))).toBe("malformed");
    }
    expect(code(() => fromBase64Url("AQIDBA", "x", 3))).toBe("malformed");
  });
});
