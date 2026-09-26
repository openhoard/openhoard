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
  /**
   * The card is metadata only (T-604): an AI client whose trust the file's exposure doesn't
   * reach gets the title, type, owner, tags and dates, never what was derived from the content
   * (its summary, extracted fields, excerpts). Always false for OpenHoard's own apps, and for
   * every shape but `card`.
   */
  metadataOnly: boolean;
  reason: string;
}

const AI_TRUST: readonly string[] = ["local", "commercial", "consumer"] satisfies ClientTrust[];

/**
 * Whether a client may have what the content says (the content itself, or a summary of it) at
 * this exposure: OpenHoard's own apps always (grants and visibility have decided already), an AI
 * client when its trust label reaches the exposure, anything else never.
 */
function contentAllowed(exposure: Exposure, trust: ReadRequest["clientTrust"]): boolean {
  if (trust === "first-party") return true;
  if (!AI_TRUST.includes(trust)) return false;
  return exposureAllowsContent(exposure, trust);
}

/**
 * Decides what a caller may see of one file. Pure and deterministic: the policy engine
 * computes `canRead`; this applies visibility and exposure on top.
 *
 * Exposure limits what AI clients get of the content, cards included (T-604): a card's summary
 * is the content in other words. An AI client whose trust the exposure doesn't reach gets a
 * card of metadata only, and never the content.
 */
export function decideRead(req: ReadRequest): ReadDecision {
  const card = (reason: string): ReadDecision => {
    if (contentAllowed(req.exposure, req.clientTrust)) {
      return { shape: "card", metadataOnly: false, reason };
    }
    return { shape: "card", metadataOnly: true, reason: `${reason}; metadata only` };
  };
  if (req.canRead !== true) {
    if (req.visibility === "hidden") {
      return { shape: "none", metadataOnly: false, reason: "hidden to non-readers" };
    }
    if (req.visibility === "discoverable") {
      return {
        shape: "title-only",
        metadataOnly: false,
        reason: "discoverable: title and request-access only",
      };
    }
    // `readable` visibility is for tenant-public material: non-readers get the card (with its
    // summary, as exposure allows the client) but never the file content.
    if (req.visibility === "readable") return card("readable visibility: card without content");
    // Anything else (bad data from storage) shows nothing.
    return { shape: "none", metadataOnly: false, reason: "unknown visibility" };
  }
  if (!req.wantsContent) return card("reader asked for a card");
  if (req.clientTrust === "first-party") {
    return { shape: "content", metadataOnly: false, reason: "person via OpenHoard app" };
  }
  // A trust label it doesn't know (bad input) gets no content, whatever the exposure.
  if (!AI_TRUST.includes(req.clientTrust)) {
    return card("unknown client trust: card without content");
  }
  if (exposureAllowsContent(req.exposure, req.clientTrust)) {
    return {
      shape: "content",
      metadataOnly: false,
      reason: `exposure ${req.exposure} allows ${req.clientTrust} client`,
    };
  }
  return card(`exposure ${req.exposure} blocks content for ${req.clientTrust} client`);
}
