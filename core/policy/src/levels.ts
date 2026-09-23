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
 * A file carries many tags; the most restrictive visibility among them wins.
 * With no tags, `fallback` applies (the tenant default).
 */
export function mostRestrictiveVisibility(
  levels: readonly Visibility[],
  fallback: Visibility = "discoverable",
): Visibility {
  return pickMostRestrictive(VISIBILITY, levels, fallback);
}

/** The most restrictive exposure among a file's tags wins. */
export function mostRestrictiveExposure(
  levels: readonly Exposure[],
  fallback: Exposure = "commercial-only",
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
    case "metadata-only":
      return false;
  }
}

function pickMostRestrictive<T extends string>(
  order: readonly T[],
  levels: readonly T[],
  fallback: T,
): T {
  if (levels.length === 0) return fallback;
  return levels.reduce((a, b) => (order.indexOf(b) < order.indexOf(a) ? b : a));
}
