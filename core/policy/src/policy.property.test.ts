import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideRead } from "./decision.js";
import {
  EXPOSURE,
  exposureAllowsContent,
  mostRestrictiveExposure,
  mostRestrictiveVisibility,
  resolveLevels,
  UNPROCESSED,
  VISIBILITY,
  type ClientTrust,
} from "./levels.js";

/*
 * Property-based tests for the fail-closed rules. Each property is a security invariant that
 * must hold for every combination of tags, levels and callers, including corrupt stored values.
 */

const visibility = fc.constantFrom(...VISIBILITY);
const exposure = fc.constantFrom(...EXPOSURE);
const trust = fc.constantFrom<ClientTrust>("local", "commercial", "consumer");
/** Any client: OpenHoard's own app or an AI client. */
const anyTrust = fc.oneof(fc.constant("first-party" as const), trust);
/** Level strings as they may come back from storage: valid values, typos and garbage. */
const storedVisibility = fc.oneof(visibility, fc.string());
const storedExposure = fc.oneof(exposure, fc.string());

const rank = <T extends string>(order: readonly T[], v: T) => order.indexOf(v);

describe("level resolution (properties)", () => {
  it("adding a tag can only tighten, never loosen", () => {
    fc.assert(
      fc.property(
        fc.array(storedVisibility),
        storedVisibility,
        fc.array(storedExposure),
        storedExposure,
        (vs, extraV, es, extraE) => {
          const v0 = mostRestrictiveVisibility(vs, "readable");
          const v1 = mostRestrictiveVisibility([...vs, extraV], "readable");
          const e0 = mostRestrictiveExposure(es, "full");
          const e1 = mostRestrictiveExposure([...es, extraE], "full");
          expect(rank(VISIBILITY, v1)).toBeLessThanOrEqual(rank(VISIBILITY, v0));
          expect(rank(EXPOSURE, e1)).toBeLessThanOrEqual(rank(EXPOSURE, e0));
        },
      ),
    );
  });

  it("an unrecognised stored value resolves to the most restrictive level", () => {
    const unknown = fc
      .string()
      .filter((s) => !(VISIBILITY as readonly string[]).includes(s))
      .filter((s) => !(EXPOSURE as readonly string[]).includes(s));
    fc.assert(
      fc.property(fc.array(storedVisibility), fc.array(storedExposure), unknown, (vs, es, bad) => {
        expect(mostRestrictiveVisibility([...vs, bad], "readable")).toBe("hidden");
        expect(mostRestrictiveExposure([...es, bad], "full")).toBe("metadata-only");
      }),
    );
  });

  it("the result is independent of tag order", () => {
    fc.assert(
      fc.property(fc.array(storedVisibility), visibility, (vs, fallback) => {
        const reversed = [...vs].reverse();
        expect(mostRestrictiveVisibility(reversed, fallback)).toBe(
          mostRestrictiveVisibility(vs, fallback),
        );
      }),
    );
  });

  it("an unprocessed file is hidden and metadata-only whatever its tags or tenant defaults", () => {
    fc.assert(
      fc.property(
        fc.array(storedVisibility),
        fc.array(storedExposure),
        visibility,
        exposure,
        (visibilities, exposures, dv, de) => {
          expect(
            resolveLevels({
              processed: false,
              visibilities,
              exposures,
              defaults: { visibility: dv, exposure: de },
            }),
          ).toEqual(UNPROCESSED);
        },
      ),
    );
  });

  it("tenant defaults apply when no tag carries a level", () => {
    fc.assert(
      fc.property(
        fc.array(storedVisibility),
        fc.array(storedExposure),
        visibility,
        exposure,
        (visibilities, exposures, dv, de) => {
          const r = resolveLevels({
            processed: true,
            visibilities,
            exposures,
            defaults: { visibility: dv, exposure: de },
          });
          if (visibilities.length === 0) expect(r.visibility).toBe(dv);
          if (exposures.length === 0) expect(r.exposure).toBe(de);
        },
      ),
    );
  });
});

describe("content release (properties)", () => {
  it("more trust never loses access, and a stricter level never gains it", () => {
    const trustOrder: ClientTrust[] = ["consumer", "commercial", "local"];
    fc.assert(
      fc.property(exposure, exposure, trust, trust, (e1, e2, t1, t2) => {
        const [looser, stricter] = rank(EXPOSURE, e1) >= rank(EXPOSURE, e2) ? [e1, e2] : [e2, e1];
        const [less, more] = trustOrder.indexOf(t1) <= trustOrder.indexOf(t2) ? [t1, t2] : [t2, t1];
        if (exposureAllowsContent(stricter, less)) {
          expect(exposureAllowsContent(looser, less)).toBe(true);
          expect(exposureAllowsContent(stricter, more)).toBe(true);
        }
      }),
    );
  });

  it("a caller without read access never receives content, and hidden files stay invisible", () => {
    fc.assert(
      fc.property(visibility, exposure, anyTrust, fc.boolean(), (v, e, t, wants) => {
        const d = decideRead({
          canRead: false,
          visibility: v,
          exposure: e,
          clientTrust: t,
          wantsContent: wants,
        });
        expect(d.shape).not.toBe("content");
        if (v === "hidden") expect(d.shape).toBe("none");
      }),
    );
  });

  it("an AI client gets content only when the exposure level allows its trust", () => {
    fc.assert(
      fc.property(visibility, exposure, trust, (v, e, t) => {
        const d = decideRead({
          canRead: true,
          visibility: v,
          exposure: e,
          clientTrust: t,
          wantsContent: true,
        });
        expect(d.shape === "content").toBe(exposureAllowsContent(e, t));
      }),
    );
  });

  it("content goes only to a reader (canRead === true) who asked for it", () => {
    const canRead = fc.oneof(
      fc.boolean(),
      fc.constantFrom<unknown>(1, "true", {}, [], null, undefined),
    );
    fc.assert(
      fc.property(canRead, visibility, exposure, anyTrust, fc.boolean(), (c, v, e, t, wants) => {
        const d = decideRead({
          canRead: c as boolean,
          visibility: v,
          exposure: e,
          clientTrust: t,
          wantsContent: wants,
        });
        const content = c === true && wants && (t === "first-party" || exposureAllowsContent(e, t));
        expect(d.shape === "content").toBe(content);
      }),
    );
  });
});
