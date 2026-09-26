import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanForMatching, decodeEntities, skeleton } from "./clean.js";

const cp = (n: number) => String.fromCodePoint(n);

describe("cleaning text for patterns", () => {
  it("deletes invisible characters, so split words are whole again", () => {
    expect(cleanForMatching(`ig${cp(0x200b)}no${cp(0xad)}re${cp(0x2060)}`, 100)).toBe("ignore");
    expect(cleanForMatching(`a${cp(0x7)}b\r\nc`, 100)).toBe("a b\nc");
  });

  it("decodes HTML references once, and nothing odd", () => {
    expect(decodeEntities("&lt;a&gt; &#47;&#x2F; &AMP; &commat; &colon")).toBe("<a> // & @ :");
    expect(decodeEntities("&#xd800; &#0; &#99999999; &bogus;")).toBe("     9; &bogus;");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("folds fullwidth by NFKC and look-alikes in the skeleton", () => {
    expect(cleanForMatching(`${cp(0xff28)}${cp(0xff34)}${cp(0xff34)}${cp(0xff30)}`, 100)).toBe(
      "http",
    );
    const cyrillic = [0x456, 0x433, 0x43d, 0x43e, 0x440, 0x435].map(cp).join("");
    expect(skeleton(cleanForMatching(cyrillic, 100))).toBe("irhope");
    expect(skeleton(`${cp(0x3bf)}${cp(0x3c1)}${cp(0x131)}é`)).toBe("opié");
  });

  it("cuts at the bound and keeps its shape on any input", () => {
    expect(cleanForMatching("x".repeat(10), 3)).toBe("xxx");
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
        const c = cleanForMatching(s, 1_000);
        expect(c).toBe(c.toLowerCase());
        expect(/\p{Cf}/u.test(c)).toBe(false);
        expect(skeleton(c).length).toBeLessThanOrEqual(c.length * 2);
      }),
    );
  });
});
