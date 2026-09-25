import { IdentityError } from "@openhoard/core-identity";
import { invalidValue, notFound, uniqueness } from "./errors.js";

/** A page of a list: `startIndex` - 1 and `count` (RFC 7644 section 3.4.2.4). */
export interface Page {
  offset: number;
  limit: number;
}

/**
 * The SCIM error for a directory refusal. The directory's messages say what was wrong with the
 * input (an unusable email, an over-long name), so they are safe to pass on; a clash says only
 * `conflict`, never which user holds the value. Anything else is rethrown (a 500, logged).
 */
export function identityError(e: unknown, conflict: string): unknown {
  if (!(e instanceof IdentityError)) return e;
  switch (e.code) {
    case "conflict":
      return uniqueness(conflict);
    case "invalid":
      return invalidValue(e.message);
    default:
      // not-found, retired, wrong-source: not a SCIM resource (any more).
      return notFound("resource");
  }
}
