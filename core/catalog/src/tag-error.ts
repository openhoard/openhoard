export type TagErrorCode =
  /** A malformed input: the tag, a label, a confidence, the applier. The message names it. */
  | "invalid"
  | "unknown-facet"
  | "unknown-object"
  | "unknown-review"
  /**
   * Deciding this would take another value of a single-value facet off the object; decide again
   * with `replace` to confirm.
   */
  | "conflict"
  /** A primary tag must be one the object carries as a trusted tag, and this one isn't. */
  | "not-on-object"
  /** The review item was decided already, perhaps by another reviewer a moment ago. */
  | "already-resolved";

/**
 * A refused proposal or decision. Inputs are checked before anything is written, so the
 * transaction can go on: model output can't abort it with a constraint violation.
 */
export class TagError extends Error {
  constructor(
    readonly code: TagErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TagError";
  }
}
