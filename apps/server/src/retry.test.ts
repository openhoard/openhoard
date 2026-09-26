import { describe, expect, it } from "vitest";
import { retrying, TRANSACTION_ATTEMPTS } from "./retry.js";

/* Requests that end access run their transaction again after a deadlock (T-106 review). */

const failing = (code: string) => Object.assign(new Error(code), { code });

describe("retrying", () => {
  it("runs a transaction again after a deadlock or serialization failure", async () => {
    for (const code of ["40P01", "40001"]) {
      let calls = 0;
      const value = await retrying(() => {
        calls++;
        return calls < TRANSACTION_ATTEMPTS
          ? Promise.reject(failing(code))
          : Promise.resolve("done");
      });
      expect([value, calls]).toEqual(["done", TRANSACTION_ATTEMPTS]);
    }
  });

  it("gives up after the last try, and never retries anything else", async () => {
    let calls = 0;
    await expect(
      retrying(() => {
        calls++;
        return Promise.reject(failing("40P01"));
      }),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(TRANSACTION_ATTEMPTS);
    calls = 0;
    await expect(
      retrying(() => {
        calls++;
        return Promise.reject(failing("23505"));
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(1);
  });
});
