import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildCard,
  clampWords,
  MAX_TAGS,
  safeLink,
  stripUnsafeText,
  type FileCard,
} from "./card.js";

/*
 * Property-based tests: card building runs on untrusted model, connector and enricher output, so
 * its guarantees must hold for ANY input, not only the examples in card.test.ts.
 */

const UNSAFE =
  // eslint-disable-next-line no-misleading-character-class -- each invisible code point is matched on its own, on purpose
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u034f\u115f\u1160\u2800\u3164\uffa0\u{e0100}-\u{e01ef}]|[\ufe00-\ufe0f]{2,}/u;
/** Any string, biased towards the characters attackers use: controls, bidi, zero-width, surrogates. */
const hostileString = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\u202e", "\u200b", "\u200d", "\u2066", "\ufeff", "\u0000", "\u001b", "\n"),
    fc.constantFrom("\u3164", "\u034f", "\ufe0f", "\ufe01", "\u{e0101}"),
    fc.constantFrom("\ud83d", "\ude00", "😀", "\u{e0041}"),
    fc.constantFrom("\ue000", "\u{f0000}", "\u0378", "\u2800", "\uffff"),
    fc.string({ unit: "grapheme", maxLength: 1 }),
    fc.string({ unit: "binary", maxLength: 1 }),
  ),
  maxLength: 400,
});

const cardInput = fc.record<FileCard>({
  id: fc.stringMatching(/^[0-9a-hjkmnp-tv-z]{26}$/).map((s) => `obj_${s}`),
  title: hostileString,
  tags: fc.array(
    fc.oneof(hostileString, fc.constantFrom("client:acme", "type:invoice", " kind:a ")),
    {
      maxLength: 40,
    },
  ),
  summary: hostileString,
  owner: hostileString,
  lastTouched: fc.oneof(
    fc.constant(""),
    fc
      .date({ min: new Date("1970-01-01"), max: new Date("9999-12-31"), noInvalidDate: true })
      .map((d) => d.toISOString()),
  ),
  link: fc.oneof(fc.webUrl(), hostileString, fc.constantFrom("javascript:alert(1)", "data:,x")),
});

/** True when every surrogate in `s` is part of a valid pair (the string is well-formed UTF-16). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);

describe("stripUnsafeText (properties)", () => {
  it("never leaves control, format or lone-surrogate characters", () => {
    fc.assert(fc.property(hostileString, (s) => !UNSAFE.test(stripUnsafeText(s))));
  });

  it("returns well-formed, trimmed, single-spaced text", () => {
    fc.assert(
      fc.property(hostileString, (s) => {
        const out = stripUnsafeText(s);
        return wellFormed(out) && out === out.trim() && !/\s{2}/.test(out);
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(hostileString, (s) => stripUnsafeText(stripUnsafeText(s)) === stripUnsafeText(s)),
    );
  });
});

describe("clampWords (properties)", () => {
  it("never exceeds the word budget", () => {
    fc.assert(
      fc.property(hostileString, fc.integer({ min: 1, max: 50 }), (s, max) => {
        const out = clampWords(s, max);
        return out === "" || out.split(" ").length <= max;
      }),
    );
  });
});

describe("safeLink (properties)", () => {
  it("returns an https URL without credentials, or nothing", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.webUrl({ authoritySettings: { withUserInfo: true } }), hostileString),
        (s) => {
          const out = safeLink(s);
          return (
            out === "" ||
            (out.startsWith("https://") &&
              new URL(out).username === "" &&
              new URL(out).password === "")
          );
        },
      ),
    );
  });
});

describe("buildCard (properties)", () => {
  it("produces a card that satisfies every documented limit", () => {
    fc.assert(
      fc.property(cardInput, (input) => {
        const c = buildCard(input);
        for (const field of [c.title, c.summary, c.owner, ...c.tags]) {
          expect(UNSAFE.test(field)).toBe(false);
          expect(wellFormed(field)).toBe(true);
        }
        expect([...c.title].length).toBeLessThanOrEqual(200);
        expect([...c.owner].length).toBeLessThanOrEqual(200);
        expect(c.summary === "" || c.summary.split(" ").length <= 100).toBe(true);
        expect(c.tags.length).toBeLessThanOrEqual(MAX_TAGS);
        expect(new Set(c.tags).size).toBe(c.tags.length);
        for (const t of c.tags)
          expect(t).toMatch(/^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/);
        expect(c.link === "" || /^https:\/\/[^@/]*\//.test(c.link)).toBe(true);
        expect(c.id).toBe(input.id);
      }),
    );
  });

  it("is idempotent, so re-processing a stored card never changes it", () => {
    fc.assert(
      fc.property(cardInput, (input) => {
        const once = buildCard(input);
        expect(buildCard(once)).toEqual(once);
      }),
    );
  });
});
