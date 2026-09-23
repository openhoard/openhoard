import { describe, expect, it } from "vitest";
import { appendEvent, canonicalJson, GENESIS_HASH, verifyChain, type AuditEvent } from "./index.js";

function chain(n: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push(
      appendEvent(events.at(-1), {
        at: `2026-09-23T12:00:0${i}Z`,
        actor: "user:steve",
        action: i % 2 ? "open" : "find",
        decision: "allow",
        client: "claude",
        object: `obj-${i}`,
      }),
    );
  }
  return events;
}

function at(events: AuditEvent[], i: number): AuditEvent {
  const e = events[i];
  if (!e) throw new Error(`no event at ${i}`);
  return e;
}

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe(
      canonicalJson({ a: [2, { d: 3 }], b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("audit chain", () => {
  it("links events from genesis", () => {
    const [first, second] = chain(2);
    expect(first?.prevHash).toBe(GENESIS_HASH);
    expect(second?.prevHash).toBe(first?.hash);
    expect(verifyChain(chain(10))).toEqual({ ok: true });
  });

  it("detects edited content", () => {
    const events = chain(5);
    events[2] = { ...at(events, 2), actor: "user:mallory" };
    expect(verifyChain(events)).toMatchObject({ ok: false, seq: 3, problem: "content altered" });
  });

  it("detects deleted events", () => {
    const events = chain(5);
    events.splice(1, 1);
    expect(verifyChain(events)).toMatchObject({ ok: false, seq: 3 });
  });

  it("detects a re-hashed forgery that breaks the link", () => {
    const events = chain(3);
    const forged = appendEvent(undefined, { ...at(events, 1), actor: "user:mallory" });
    events[1] = { ...forged, seq: 2 };
    expect(verifyChain(events)).toMatchObject({ ok: false, seq: 2, problem: "prevHash mismatch" });
  });
});
