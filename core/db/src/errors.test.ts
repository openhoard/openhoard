import { describe, expect, it } from "vitest";
import { isRetryable, sqlState } from "./errors.js";

describe("sqlState", () => {
  it("reads the SQLSTATE however the driver wraps it", () => {
    expect(sqlState({ code: "23505" })).toBe("23505");
    // Drizzle wraps the driver's error and keeps it in `cause`, which wins.
    expect(sqlState(Object.assign(new Error("x"), { cause: { code: "40001" } }))).toBe("40001");
    expect(sqlState({ code: "XX000", cause: { code: "40P01" } })).toBe("40P01");
    expect(sqlState({ code: "23505", cause: null })).toBe("23505");
  });

  it("is undefined for anything else", () => {
    for (const e of [undefined, null, "40001", 40001, new Error("x"), { code: 40001 }]) {
      expect(sqlState(e)).toBeUndefined();
    }
  });
});

describe("isRetryable", () => {
  it("says to retry serialization failures and deadlocks only", () => {
    expect(isRetryable({ code: "40001" })).toBe(true);
    expect(isRetryable({ cause: { code: "40P01" } })).toBe(true);
    for (const code of ["23505", "23514", "57014", "25006"]) {
      expect(isRetryable({ code })).toBe(false);
    }
    expect(isRetryable(new Error("40001"))).toBe(false);
  });
});
