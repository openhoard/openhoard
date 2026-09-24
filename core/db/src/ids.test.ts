import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idPattern, isId, newId, type IdKind } from "./ids.js";

const kinds = Object.keys(ID_PREFIXES) as IdKind[];
const kind = fc.constantFrom(...kinds);
const time = fc.integer({ min: 0, max: 2 ** 48 - 1 });
const random = fc.uint8Array({ minLength: 10, maxLength: 10 });

describe("newId", () => {
  it("has the prefix and 26 Crockford base32 characters", () => {
    expect(newId("object")).toMatch(/^obj_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("encodes a known ULID", () => {
    // 2^48 - 1 ms and all-ones randomness is the largest ULID, 7zzzzzzzzzzzzzzzzzzzzzzzzz.
    expect(newId("tenant", 2 ** 48 - 1, new Uint8Array(10).fill(255))).toBe(
      "ten_7zzzzzzzzzzzzzzzzzzzzzzzzz",
    );
    expect(newId("zone", 0, new Uint8Array(10))).toBe("zon_00000000000000000000000000");
    // 1 ms, randomness 0x00…01.
    expect(newId("version", 1, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 1))).toBe(
      "ver_00000000010000000000000001",
    );
  });

  it("rejects timestamps and randomness it cannot encode", () => {
    expect(() => newId("object", -1)).toThrow(RangeError);
    expect(() => newId("object", 2 ** 48)).toThrow(RangeError);
    expect(() => newId("object", 1.5)).toThrow(RangeError);
    expect(() => newId("object", 0, new Uint8Array(9))).toThrow(RangeError);
  });

  it("always matches its kind's pattern and no other kind's (property)", () => {
    fc.assert(
      fc.property(kind, time, random, (k, t, r) => {
        const id = newId(k, t, r);
        expect(isId(k, id)).toBe(true);
        expect(new RegExp(idPattern(k)).test(id)).toBe(true);
        for (const other of kinds) if (other !== k) expect(isId(other, id)).toBe(false);
        expect(id).not.toContain(":");
      }),
    );
  });

  it("sorts by time as a string (property)", () => {
    fc.assert(
      fc.property(time, time, random, random, (t1, t2, r1, r2) => {
        fc.pre(t1 !== t2);
        const [a, b] = [newId("object", t1, r1), newId("object", t2, r2)];
        expect(a < b).toBe(t1 < t2);
      }),
    );
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId("object")));
    expect(ids.size).toBe(10_000);
  });
});

describe("isId", () => {
  it.each([
    ["", false],
    ["obj_", false],
    ["obj_0000000000000000000000000", false], // 25 characters
    ["obj_000000000000000000000000000", false], // 27 characters
    ["obj_0000000000000000000000000i", false], // i, l, o and u are not in the alphabet
    ["OBJ_00000000000000000000000000", false],
    ["obj_0000000000000000000000000A", false],
    ["obj_00000000000000000000000000\n", false],
    ["obj_00000000000000000000000000", true],
  ])("isId(object, %j) is %s", (id, ok) => {
    expect(isId("object", id)).toBe(ok);
  });
});
