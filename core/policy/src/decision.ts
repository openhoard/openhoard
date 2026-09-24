import {
  exposureAllowsContent,
  type ClientTrust,
  type Exposure,
  type Visibility,
} from "./levels.js";

/** What a caller gets back for a file in search or `open`. */
export type ResultShape = "none" | "title-only" | "card" | "content";

export interface ReadRequest {
  /** Whether the caller's principal set grants read access. */
  canRead: boolean;
  visibility: Visibility;
  exposure: Exposure;
  /** Present when the caller is an AI client rather than a person in an OpenHoard UI. */
  clientTrust?: ClientTrust;
  /** Whether the caller asked for file content (vs. a card). */
  wantsContent: boolean;
}

export interface ReadDecision {
  shape: ResultShape;
  reason: string;
}

/**
 * Decides what a caller may see of one file. Pure and deterministic: the policy engine
 * computes `canRead`; this applies visibility and exposure on top.
 */
export function decideRead(req: ReadRequest): ReadDecision {
  if (!req.canRead) {
    if (req.visibility === "hidden") return { shape: "none", reason: "hidden to non-readers" };
    if (req.visibility === "discoverable")
      return { shape: "title-only", reason: "discoverable: title and request-access only" };
    // `readable` visibility is for tenant-public material: non-readers get the card (which
    // includes the summary) but never the file content.
    return { shape: "card", reason: "readable visibility: card without content" };
  }
  if (!req.wantsContent) return { shape: "card", reason: "reader asked for a card" };
  if (req.clientTrust === undefined)
    return { shape: "content", reason: "person via OpenHoard client" };
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
