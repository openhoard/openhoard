import { randomBytes } from "node:crypto";

/*
 * Row ids: `<prefix>_<26 characters>`, e.g. `obj_01k5xr3c8v0q6m2d4n7p9s1t3w`.
 *
 * The 26 characters are a ULID in lower-case Crockford base32: 48 bits of milliseconds then 80
 * random bits. Ids sort roughly by creation time, which keeps B-tree inserts local, and they are
 * generated in the application because gen_random_uuid()/uuidv7() differ across the Postgres
 * versions we support. The prefix makes a misplaced id obvious (an object id passed where a
 * version id is expected fails the column's check constraint instead of matching nothing), and
 * the alphabet has no `:`, so an id can never be confused with a principal such as `user:…`.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Prefixes in use, one per table. The database checks the same patterns. */
export const ID_PREFIXES = {
  tenant: "ten",
  zone: "zon",
  object: "obj",
  version: "ver",
  grant: "grt",
  review: "rev",
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

/** The regular expression (POSIX and JavaScript compatible) an id of `kind` must match. */
export function idPattern(kind: IdKind): string {
  return `^${ID_PREFIXES[kind]}_[0-9a-hjkmnp-tv-z]{26}$`;
}

/** A new id for a row of `kind`. `now` and `random` exist for tests. */
export function newId(
  kind: IdKind,
  now = Date.now(),
  random: Uint8Array = randomBytes(10),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError("timestamp out of range");
  }
  if (random.byteLength !== 10) throw new RangeError("expected 10 random bytes");
  let out = "";
  // 48-bit time → 10 characters (the top 2 bits of the first are always zero).
  let t = now;
  const time: string[] = [];
  for (let i = 0; i < 10; i++) {
    time.push(ALPHABET[t % 32] as string);
    t = Math.floor(t / 32);
  }
  out += time.reverse().join("");
  // 80 random bits → 16 characters, 5 bits at a time.
  let acc = 0;
  let bits = 0;
  for (const byte of random) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31] as string;
    }
    acc &= (1 << bits) - 1;
  }
  return `${ID_PREFIXES[kind]}_${out}`;
}

/** True when `id` is a well-formed id of `kind`. */
export function isId(kind: IdKind, id: string): boolean {
  return new RegExp(idPattern(kind)).test(id);
}
