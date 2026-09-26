import { describe, expect, it } from "vitest";
import {
  decideRead,
  exposureAllowsContent,
  mayProcess,
  mostRestrictiveExposure,
  mostRestrictiveVisibility,
  resolveLevels,
  UNPROCESSED,
  type ClientTrust,
  type Exposure,
  type ProviderKind,
  type ReadRequest,
} from "./index.js";

describe("most restrictive wins", () => {
  it("visibility", () => {
    expect(mostRestrictiveVisibility(["readable", "hidden", "discoverable"])).toBe("hidden");
    expect(mostRestrictiveVisibility(["readable", "discoverable"])).toBe("discoverable");
    expect(mostRestrictiveVisibility(["readable"])).toBe("readable");
  });

  it("exposure", () => {
    expect(mostRestrictiveExposure(["full", "local-only"])).toBe("local-only");
    expect(mostRestrictiveExposure(["full", "metadata-only", "local-only"])).toBe("metadata-only");
  });

  it("fails closed with no levels", () => {
    expect(mostRestrictiveVisibility([])).toBe("hidden");
    expect(mostRestrictiveExposure([])).toBe("metadata-only");
    expect(mostRestrictiveVisibility([], "readable")).toBe("readable");
  });

  it("treats unknown values as the most restrictive level", () => {
    expect(mostRestrictiveVisibility(["readable", "publik"])).toBe("hidden");
    expect(mostRestrictiveExposure(["full", "everyone"])).toBe("metadata-only");
  });
});

describe("resolveLevels", () => {
  const defaults = { visibility: "discoverable", exposure: "commercial-only" } as const;

  it("keeps unprocessed files hidden and metadata-only, whatever their tags say", () => {
    expect(
      resolveLevels({
        processed: false,
        visibilities: ["readable"],
        exposures: ["full"],
        defaults,
      }),
    ).toEqual(UNPROCESSED);
  });

  it("applies tenant defaults to processed files without level-bearing tags", () => {
    expect(resolveLevels({ processed: true, visibilities: [], exposures: [], defaults })).toEqual(
      defaults,
    );
  });

  it("lets tags tighten processed files", () => {
    expect(
      resolveLevels({
        processed: true,
        visibilities: ["hidden"],
        exposures: ["local-only"],
        defaults,
      }),
    ).toEqual({ visibility: "hidden", exposure: "local-only" });
  });

  it("keeps the fail-closed default out of reach of callers", () => {
    const input = { processed: false, visibilities: [], exposures: [], defaults };
    const first = resolveLevels(input);
    expect(first).not.toBe(UNPROCESSED);
    first.visibility = "readable";
    first.exposure = "full";
    expect(UNPROCESSED).toEqual({ visibility: "hidden", exposure: "metadata-only" });
    expect(resolveLevels(input)).toEqual({ visibility: "hidden", exposure: "metadata-only" });
    expect(Object.isFrozen(UNPROCESSED)).toBe(true);
    expect(() => {
      (UNPROCESSED as { visibility: string }).visibility = "readable";
    }).toThrow(TypeError);
    expect(UNPROCESSED.visibility).toBe("hidden");
  });
});

describe("exposureAllowsContent", () => {
  const table: [Exposure, ClientTrust, boolean][] = [
    ["full", "consumer", true],
    ["commercial-only", "consumer", false],
    ["commercial-only", "commercial", true],
    ["commercial-only", "local", true],
    ["local-only", "commercial", false],
    ["local-only", "local", true],
    ["metadata-only", "local", false],
  ];
  it.each(table)("%s + %s client → %s", (exposure, trust, expected) => {
    expect(exposureAllowsContent(exposure, trust)).toBe(expected);
  });

  it("never allows content for unknown exposure values", () => {
    expect(exposureAllowsContent("bogus" as Exposure, "local")).toBe(false);
  });
});

describe("mayProcess (enrichment, T-604)", () => {
  const table: [Exposure, ProviderKind, boolean][] = [
    ["full", "consumer", true],
    ["full", "local", true],
    ["commercial-only", "consumer", false],
    ["commercial-only", "commercial", true],
    ["commercial-only", "local", true],
    ["local-only", "consumer", false],
    ["local-only", "commercial", false],
    ["local-only", "local", true],
    ["metadata-only", "local", false],
    ["metadata-only", "commercial", false],
  ];
  it.each(table)("%s content to a %s provider → %s", (exposure, provider, expected) => {
    expect(mayProcess(exposure, provider)).toBe(expected);
  });

  it("sends nothing to a provider of a kind it doesn't know, or at an unknown exposure", () => {
    expect(mayProcess("full", "first-party" as ProviderKind)).toBe(false);
    expect(mayProcess("full", "cloud" as ProviderKind)).toBe(false);
    expect(mayProcess("secret" as Exposure, "local")).toBe(false);
  });
});

describe("decideRead", () => {
  const base = {
    visibility: "readable",
    exposure: "full",
    clientTrust: "first-party",
    wantsContent: true,
  } as const;

  it("gives a non-reader whose read a policy forbids a metadata-only card of a readable file", () => {
    for (const clientTrust of ["first-party", "local", "consumer"] as const) {
      expect(
        decideRead({
          ...base,
          clientTrust,
          canRead: false,
          readForbidden: true,
          wantsContent: false,
        }),
      ).toMatchObject({ shape: "card", metadataOnly: true });
      expect(
        decideRead({
          ...base,
          clientTrust,
          canRead: false,
          readForbidden: false,
          wantsContent: false,
        }),
      ).toMatchObject({ shape: "card", metadataOnly: false });
    }
  });

  it("non-readers see according to visibility", () => {
    expect(decideRead({ ...base, canRead: false, visibility: "hidden" }).shape).toBe("none");
    expect(decideRead({ ...base, canRead: false, visibility: "discoverable" }).shape).toBe(
      "title-only",
    );
    expect(decideRead({ ...base, canRead: false }).shape).toBe("card");
  });

  it("shows non-readers nothing for a visibility it doesn't know (bad data)", () => {
    const bad = "public" as unknown as "readable";
    expect(decideRead({ ...base, canRead: false, visibility: bad }).shape).toBe("none");
  });

  it("readers get cards unless they ask for content", () => {
    expect(decideRead({ ...base, canRead: true, wantsContent: false }).shape).toBe("card");
    expect(decideRead({ ...base, canRead: true }).shape).toBe("content");
  });

  it("AI clients get content only when exposure allows", () => {
    const r = { ...base, canRead: true, exposure: "commercial-only" } as const;
    expect(decideRead({ ...r, clientTrust: "commercial" })).toMatchObject({
      shape: "content",
      metadataOnly: false,
    });
    const blocked = decideRead({ ...r, clientTrust: "consumer" });
    expect(blocked).toMatchObject({ shape: "card", metadataOnly: true });
    expect(blocked.reason).toMatch(/blocks content for consumer/);
  });

  it("gives content without an exposure check only to OpenHoard's own app", () => {
    const r = { ...base, canRead: true, exposure: "metadata-only" } as const;
    expect(decideRead(r)).toEqual({
      shape: "content",
      metadataOnly: false,
      reason: "person via OpenHoard app",
    });
    expect(decideRead({ ...r, clientTrust: "local" })).toMatchObject({
      shape: "card",
      metadataOnly: true,
    });
  });

  it("treats a missing or unknown client trust as no content", () => {
    // Callers may pass parsed input; leaving the trust out must not mean first-party.
    const { clientTrust: _, ...noTrust } = { ...base, canRead: true };
    expect(decideRead(noTrust as unknown as ReadRequest)).toMatchObject({
      shape: "card",
      metadataOnly: true,
    });
    const bogus = { ...base, canRead: true, clientTrust: "trusted" as unknown as "local" };
    expect(decideRead(bogus)).toEqual({
      shape: "card",
      metadataOnly: true,
      reason: "unknown client trust: card without content; metadata only",
    });
  });

  // T-604: "consumer client gets metadata only for commercial-only tags".
  const trusts = ["first-party", "local", "commercial", "consumer"] as const;
  const exposures = ["full", "commercial-only", "local-only", "metadata-only"] as const;
  const reaches: Record<(typeof trusts)[number], readonly string[]> = {
    "first-party": exposures,
    local: ["full", "commercial-only", "local-only"],
    commercial: ["full", "commercial-only"],
    consumer: ["full"],
  };
  const cases = trusts.flatMap((trust) => exposures.map((exposure) => [trust, exposure] as const));
  it.each(cases)("a %s client's cards and content at %s exposure", (trust, exposure) => {
    const allowed = reaches[trust].includes(exposure);
    const r = { ...base, canRead: true, exposure, clientTrust: trust } as const;
    // A reader's card: its summary only where the content could go.
    expect(decideRead({ ...r, wantsContent: false })).toMatchObject({
      shape: "card",
      metadataOnly: !allowed,
    });
    // Opening: the content, or the card as metadata.
    expect(decideRead(r)).toMatchObject(
      allowed ? { shape: "content", metadataOnly: false } : { shape: "card", metadataOnly: true },
    );
    // A non-reader's card of a readable file follows the same rule; title-only has no summary.
    expect(decideRead({ ...r, canRead: false })).toMatchObject({
      shape: "card",
      metadataOnly: !allowed,
    });
    expect(decideRead({ ...r, canRead: false, visibility: "discoverable" })).toMatchObject({
      shape: "title-only",
      metadataOnly: false,
    });
  });

  it("only canRead === true makes a reader", () => {
    for (const truthy of [1, "yes", {}, [true]]) {
      const r = { ...base, canRead: truthy as unknown as boolean, visibility: "hidden" } as const;
      expect(decideRead(r).shape).toBe("none");
    }
  });
});
