import { describe, expect, it } from "vitest";
import {
  decideRead,
  exposureAllowsContent,
  mostRestrictiveExposure,
  mostRestrictiveVisibility,
  resolveLevels,
  UNPROCESSED,
  type ClientTrust,
  type Exposure,
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

describe("decideRead", () => {
  const base = { visibility: "readable", exposure: "full", wantsContent: true } as const;

  it("non-readers see according to visibility", () => {
    expect(decideRead({ ...base, canRead: false, visibility: "hidden" }).shape).toBe("none");
    expect(decideRead({ ...base, canRead: false, visibility: "discoverable" }).shape).toBe(
      "title-only",
    );
    expect(decideRead({ ...base, canRead: false }).shape).toBe("card");
  });

  it("readers get cards unless they ask for content", () => {
    expect(decideRead({ ...base, canRead: true, wantsContent: false }).shape).toBe("card");
    expect(decideRead({ ...base, canRead: true }).shape).toBe("content");
  });

  it("AI clients get content only when exposure allows", () => {
    const r = { ...base, canRead: true, exposure: "commercial-only" } as const;
    expect(decideRead({ ...r, clientTrust: "commercial" }).shape).toBe("content");
    const blocked = decideRead({ ...r, clientTrust: "consumer" });
    expect(blocked.shape).toBe("card");
    expect(blocked.reason).toMatch(/blocks content for consumer/);
  });
});
