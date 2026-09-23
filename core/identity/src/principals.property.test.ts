import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canSee, principalSet } from "./principals.js";

const subject = fc.record({
  userId: fc.string(),
  groupIds: fc.array(fc.string()),
  tagGrants: fc.array(fc.string()),
});

describe("principalSet (properties)", () => {
  it("has no duplicates and namespaces every entry", () => {
    fc.assert(
      fc.property(subject, (s) => {
        const set = principalSet(s);
        expect(new Set(set).size).toBe(set.length);
        for (const p of set) expect(p).toMatch(/^(user|group|tag):/);
      }),
    );
  });

  it("a group can never impersonate a user with the same name", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const asGroup = principalSet({ userId: "someone-else", groupIds: [name], tagGrants: [] });
        expect(canSee([`user:${name}`], asGroup)).toBe(name === "someone-else");
      }),
    );
  });
});

describe("canSee (properties)", () => {
  it("is true exactly when the two lists share an entry", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.array(fc.string()), (visibleTo, principals) => {
        expect(canSee(visibleTo, principals)).toBe(visibleTo.some((p) => principals.includes(p)));
      }),
    );
  });
});
