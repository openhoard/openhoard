import { describe, expect, it } from "vitest";
import { personalName } from "./names.js";

describe("personalName", () => {
  it("drops a trailing company in parentheses and nothing else", () => {
    expect(personalName("Sam Rossi (Acme Corp)")).toBe("Sam Rossi");
    expect(personalName("Sam (Sammy) Rossi")).toBe("Sam (Sammy) Rossi");
    expect(personalName("Sam Rossi")).toBe("Sam Rossi");
    expect(personalName("(Acme)")).toBe("(Acme)");
  });

  it("is linear on hostile input", () => {
    const start = performance.now();
    personalName(`x${" (".repeat(200_000)}`);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
