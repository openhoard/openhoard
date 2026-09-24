import {
  exposureAllowsContent,
  type ClientTrust,
  type Exposure,
  type Visibility,
} from "./levels.js";

/** What a caller gets back for a file in search or `open`. */
export type ResultShape = "none" | "title-only" | "card" | "content";

export interface ReadRequest {
  /** Whether the caller's principal set grants read access. Only `true` makes a reader. */
  canRead: boolean;
  visibility: Visibility;
  exposure: Exposure;
  /**
   * The client the request comes through (authorize()'s `client.trust`): `first-party` for
   * OpenHoard's own apps, otherwise the AI client's trust label. Required, so a caller can't
   * get first-party treatment by leaving it out.
   */
  clientTrust: "first-party" | ClientTrust;
  /** Whether the caller asked for file content (vs. a card). */
  wantsContent: boolean;
}

export interface ReadDecision {
  shape: ResultShape;
  reason: string;
}

const AI_TRUST: readonly string[] = ["local", "commercial", "consumer"] satisfies ClientTrust[];

/**
 * Decides what a caller may see of one file. Pure and deterministic: the policy engine
 * computes `canRead`; this applies visibility and exposure on top.
 */
export function decideRead(req: ReadRequest): ReadDecision {
  if (req.canRead !== true) {
    if (req.visibility === "hidden") return { shape: "none", reason: "hidden to non-readers" };
    if (req.visibility === "discoverable")
      return { shape: "title-only", reason: "discoverable: title and request-access only" };
    // `readable` visibility is for tenant-public material: non-readers get the card (which
    // includes the summary) but never the file content.
    if (req.visibility === "readable")
      return { shape: "card", reason: "readable visibility: card without content" };
    // Anything else (bad data from storage) shows nothing.
    return { shape: "none", reason: "unknown visibility" };
  }
  if (!req.wantsContent) return { shape: "card", reason: "reader asked for a card" };
  if (req.clientTrust === "first-party")
    return { shape: "content", reason: "person via OpenHoard app" };
  // A trust label it doesn't know (bad input) gets no content, whatever the exposure.
  if (!AI_TRUST.includes(req.clientTrust))
    return { shape: "card", reason: "unknown client trust: card without content" };
  if (exposureAllowsContent(req.exposure, req.clientTrust))
    return {
      shape: "content",
      reason: `exposure ${req.exposure} allows ${req.clientTrust} client`,
    };
  return {
    shape: "card",
    reason: `exposure ${req.exposure} blocks content for ${req.clientTrust} client`,
  };
}
