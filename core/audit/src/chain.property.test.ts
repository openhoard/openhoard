import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  appendEvent,
  canonicalJson,
  verifyChain,
  type AuditEvent,
  type AuditInput,
} from "./chain.js";

/*
 * Property-based tests: the audit chain must detect ANY single edit, deletion, insertion or
 * reordering, and hashing must never depend on how an object's keys happen to be ordered.
 */

const detailValue = fc.oneof(fc.string(), fc.integer(), fc.boolean());
const auditInput = (tenantId: string) =>
  fc.record<AuditInput>(
    {
      tenantId: fc.constant(tenantId),
      at: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      actor: fc.string({ minLength: 1 }),
      action: fc.constantFrom("read", "search", "share", "tag", "open"),
      decision: fc.constantFrom("allow", "deny"),
      client: fc.string(),
      object: fc.string(),
      version: fc.string(),
      detail: fc.dictionary(fc.string(), detailValue, { maxKeys: 5 }),
    },
    { requiredKeys: ["tenantId", "at", "actor", "action", "decision"] },
  );

const buildChain = (inputs: AuditInput[]) =>
  inputs.reduce<AuditEvent[]>((chain, input) => [...chain, appendEvent(chain.at(-1), input)], []);

const chain = fc.array(auditInput("t1"), { minLength: 1, maxLength: 12 }).map(buildChain);

/** Rebuilds an object with its keys inserted in a random order, recursively. */
const shuffleKeys = (value: unknown, seed: number): unknown => {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, seed));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    entries.sort(([a], [b]) => ((hash(a) ^ seed) - (hash(b) ^ seed)) | 0);
    return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v, seed)]));
  }
  return value;
};
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

describe("canonicalJson (properties)", () => {
  it("does not depend on key order", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer(), (v, seed) => {
        expect(canonicalJson(shuffleKeys(v, seed))).toBe(canonicalJson(v));
      }),
    );
  });

  it("round-trips to an equal value (it is valid JSON)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(JSON.parse(canonicalJson(v))).toEqual(JSON.parse(JSON.stringify(v)));
      }),
    );
  });
});

describe("verifyChain (properties)", () => {
  it("accepts every chain built with appendEvent", () => {
    fc.assert(
      fc.property(chain, (events) => {
        expect(verifyChain(events)).toEqual({ ok: true });
      }),
    );
  });

  it("detects an edit to any field of any event", () => {
    fc.assert(
      fc.property(
        chain,
        fc.nat(),
        fc.constantFrom("actor", "action", "at", "object"),
        (events, i, field) => {
          const at = i % events.length;
          const edited = events.map((e, j) =>
            j === at ? { ...e, [field]: `${String(e[field])}x` } : e,
          );
          expect(verifyChain(edited).ok).toBe(false);
        },
      ),
    );
  });

  it("detects a deleted event anywhere except the tail", () => {
    fc.assert(
      fc.property(
        chain.filter((c) => c.length >= 2),
        fc.nat(),
        (events, i) => {
          const at = i % (events.length - 1);
          expect(verifyChain(events.filter((_, j) => j !== at)).ok).toBe(false);
        },
      ),
    );
  });

  it("detects two events swapped", () => {
    fc.assert(
      fc.property(
        chain.filter((c) => c.length >= 2),
        fc.nat(),
        (events, i) => {
          const at = i % (events.length - 1);
          const swapped = [
            ...events.slice(0, at),
            ...events.slice(at, at + 2).reverse(),
            ...events.slice(at + 2),
          ];
          expect(verifyChain(swapped).ok).toBe(false);
        },
      ),
    );
  });

  it("detects an event moved in from another tenant's chain", () => {
    fc.assert(
      fc.property(chain, fc.array(auditInput("t2"), { minLength: 1 }), (events, other) => {
        const [foreign] = buildChain(other);
        if (!foreign) throw new Error("generator produced no foreign event");
        expect(verifyChain([...events, { ...foreign, seq: events.length + 1 }]).ok).toBe(false);
      }),
    );
  });
});
