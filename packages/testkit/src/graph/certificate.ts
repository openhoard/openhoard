import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/*
 * A self-signed RSA certificate made at run time, for tests of certificate credentials (T-302):
 * no key is kept in the repository, and nothing but Node is needed to make one. The DER is
 * written by hand: an X.509 v3 certificate with a common name and nothing else.
 */

export interface TestCertificate {
  /** The certificate, PEM. */
  certificate: string;
  /** Its private key, PEM (PKCS #8). */
  privateKey: string;
}

function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const size: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) size.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | size.length, ...size]), body]);
}

const sequence = (...parts: Uint8Array[]) => der(0x30, ...parts);
/** UTCTime: two-digit years, which reach 2049. */
function time(at: Date): Buffer {
  const year = at.getUTCFullYear();
  if (!(year >= 1950 && year <= 2049)) {
    throw new RangeError("a test certificate's dates must be between 1950 and 2049");
  }
  return der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`, "ascii"));
}

const SHA256_WITH_RSA = sequence(
  der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
  der(0x05),
);
const COMMON_NAME = der(0x06, Buffer.from([0x55, 0x04, 0x03]));

/** A new 2048-bit RSA key and a certificate for it, valid from `from` for `days`. */
export function selfSignedCertificate({
  commonName = "openhoard-test",
  from = new Date(Date.now() - 3_600_000),
  days = 30,
}: { commonName?: string; from?: Date; days?: number } = {}): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const name = sequence(
    der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from(commonName, "utf8")))),
  );
  const serial = randomBytes(8);
  serial[0] = (serial[0] as number) & 0x7f; // a positive INTEGER
  if (serial[0] === 0) serial[0] = 1;
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, serial),
    SHA256_WITH_RSA,
    name,
    sequence(time(from), time(new Date(from.getTime() + days * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, SHA256_WITH_RSA, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) as string[];
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
