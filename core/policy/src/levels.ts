/**
 * Visibility decides whether a file's existence and title can be seen by someone who can't read it.
 * Ordered from most to least restrictive.
 */
export const VISIBILITY = ["hidden", "discoverable", "readable"] as const;
export type Visibility = (typeof VISIBILITY)[number];

/**
 * Exposure decides which AI clients (and plugins) may receive a file's content.
 * Ordered from most to least restrictive.
 */
export const EXPOSURE = ["metadata-only", "local-only", "commercial-only", "full"] as const;
export type Exposure = (typeof EXPOSURE)[number];

/** How far an AI client is trusted with content, set by an admin on the client allowlist. */
export type ClientTrust = "local" | "commercial" | "consumer";

/**
 * FAIL-CLOSED DEFAULTS (security review #1).
 * A file that has not finished ingest/tagging is treated as `hidden` + `metadata-only`, so a
 * sensitive file's title and content never leak in the window before its tags are known.
 * Tenant defaults (e.g. `discoverable` for internal work) apply only once a file is processed.
 */
export const UNPROCESSED: { visibility: Visibility; exposure: Exposure } = {
  visibility: "hidden",
  exposure: "metadata-only",
};

export interface TenantDefaults {
  visibility: Visibility;
  exposure: Exposure;
}

/**
 * Effective visibility/exposure for one file.
 * - Unprocessed files get {@link UNPROCESSED}, whatever their (possibly partial) tags say.
 * - Processed files: the most restrictive level among their tags wins; with no level-bearing
 *   tags, the tenant default applies.
 */
export function resolveLevels(input: {
  processed: boolean;
  visibilities: readonly string[];
  exposures: readonly string[];
  defaults: TenantDefaults;
}): { visibility: Visibility; exposure: Exposure } {
  if (!input.processed) return UNPROCESSED;
  return {
    visibility: mostRestrictiveVisibility(input.visibilities, input.defaults.visibility),
    exposure: mostRestrictiveExposure(input.exposures, input.defaults.exposure),
  };
}

/** Most restrictive visibility wins. Empty input returns `fallback` (fail-closed by default). */
export function mostRestrictiveVisibility(
  levels: readonly string[],
  fallback: Visibility = UNPROCESSED.visibility,
): Visibility {
  return pickMostRestrictive(VISIBILITY, levels, fallback);
}

/** Most restrictive exposure wins. Empty input returns `fallback` (fail-closed by default). */
export function mostRestrictiveExposure(
  levels: readonly string[],
  fallback: Exposure = UNPROCESSED.exposure,
): Exposure {
  return pickMostRestrictive(EXPOSURE, levels, fallback);
}

/** Whether a client with `trust` may receive file content at this exposure level. */
export function exposureAllowsContent(exposure: Exposure, trust: ClientTrust): boolean {
  switch (exposure) {
    case "full":
      return true;
    case "commercial-only":
      return trust === "commercial" || trust === "local";
    case "local-only":
      return trust === "local";
    default:
      // "metadata-only" and any unknown value from storage: never hand out content.
      return false;
  }
}

/**
 * Picks the most restrictive level. Values that are not recognised (bad data, a newer schema,
 * a typo in a pack) count as the MOST restrictive level, so corruption can only tighten access.
 */
function pickMostRestrictive<T extends string>(
  order: readonly T[],
  levels: readonly string[],
  fallback: T,
): T {
  if (levels.length === 0) return fallback;
  let best = order.length - 1;
  for (const level of levels) {
    const i = order.indexOf(level as T);
    best = Math.min(best, i === -1 ? 0 : i);
  }
  return order[best] as T;
}
