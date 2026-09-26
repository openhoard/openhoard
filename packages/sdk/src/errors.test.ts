import { describe, expect, it } from "vitest";
import {
  authError,
  changedError,
  ConnectorError,
  errorCode,
  isAbortError,
  isConnectorError,
  MAX_RETRY_AFTER_MS,
  notFoundError,
  permanentError,
  resyncError,
  retryableError,
  retryDelayMs,
  throttledError,
} from "./errors.js";

describe("connector errors", () => {
  it("gives each helper its code, and says which can be retried", () => {
    const cases = [
      [retryableError("x"), "retryable", true],
      [throttledError(10), "throttled", true],
      [authError("x"), "auth", false],
      [permanentError("x"), "permanent", false],
      [notFoundError(), "not-found", false],
      [changedError(), "changed", false],
      [resyncError(), "resync", false],
    ] as const;
    for (const [e, code, retryable] of cases) {
      expect(e.code).toBe(code);
      expect(e.retryable).toBe(retryable);
      expect(e.name).toBe("ConnectorError");
      expect(errorCode(e)).toBe(code);
    }
  });

  it("keeps a throttle's wait within 0 and an hour, and only on throttled", () => {
    expect(throttledError(1_500.2).retryAfterMs).toBe(1_501);
    expect(throttledError(-5).retryAfterMs).toBe(0);
    expect(throttledError(Number.NaN).retryAfterMs).toBe(0);
    expect(throttledError(10 * MAX_RETRY_AFTER_MS).retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
    expect(new ConnectorError("retryable", "x", { retryAfterMs: 5 }).retryAfterMs).toBeUndefined();
  });

  it("treats an unknown code as retryable, and keeps the cause", () => {
    const cause = new Error("inner");
    const e = new ConnectorError("bogus" as never, "x", { cause });
    expect(e.code).toBe("retryable");
    expect(e.cause).toBe(cause);
  });

  it("recognizes a ConnectorError from another copy of the package by its shape", () => {
    expect(isConnectorError({ name: "ConnectorError", code: "changed" })).toBe(true);
    expect(isConnectorError({ name: "ConnectorError", code: "whatever" })).toBe(false);
    expect(isConnectorError(new Error("x"))).toBe(false);
    expect(isConnectorError(null)).toBe(false);
    expect(isConnectorError("changed")).toBe(false);
    expect(errorCode(new Error("x"))).toBe("retryable");
  });

  it("recognizes cancellations", () => {
    const c = new AbortController();
    const reason = new Error("stop");
    c.abort(reason);
    expect(isAbortError(reason, c.signal)).toBe(true);
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("x"), c.signal)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it("waits what a throttle asks, else backs off exponentially with jitter", () => {
    expect(retryDelayMs(throttledError(2_000), 5)).toBe(2_000);
    const half = () => 0.5;
    expect(retryDelayMs(retryableError("x"), 1, { random: half })).toBe(750);
    expect(retryDelayMs(new Error("x"), 3, { random: half })).toBe(3_000);
    expect(retryDelayMs(new Error("x"), 30, { random: () => 1 })).toBe(60_000);
    expect(retryDelayMs(new Error("x"), 1, { random: () => 0 })).toBe(500);
  });
});
