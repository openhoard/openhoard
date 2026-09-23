import { describe, expect, it } from "vitest";
import { canSee, principalSet } from "./index.js";

describe("principalSet", () => {
  it("namespaces and de-duplicates", () => {
    expect(
      principalSet({
        userId: "steve",
        groupIds: ["steve", "sales", "sales"],
        tagGrants: ["client:acme"],
      }),
    ).toEqual(["user:steve", "group:steve", "group:sales", "tag:client:acme"]);
  });
});

describe("canSee", () => {
  const principals = principalSet({ userId: "dana", groupIds: ["acme-team"], tagGrants: [] });

  it("matches on any shared principal", () => {
    expect(canSee(["group:acme-team"], principals)).toBe(true);
    expect(canSee(["user:steve", "group:finance"], principals)).toBe(false);
    expect(canSee([], principals)).toBe(false);
  });
});
