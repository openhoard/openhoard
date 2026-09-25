/*
 * SCIM errors (RFC 7644 section 3.12): every refusal the SCIM endpoint gives is one of these,
 * as `{"schemas": [Error], "status": "400", "scimType": "invalidValue", "detail": "…"}`. The
 * detail says what was wrong with the request, never anything about the server's internals.
 */

export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/** The scimType values RFC 7644 defines for 400s (and `uniqueness` for 409). */
export type ScimType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

export type ScimStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 501;

export class ScimError extends Error {
  constructor(
    readonly status: ScimStatus,
    detail: string,
    readonly scimType?: ScimType,
  ) {
    super(detail);
    this.name = "ScimError";
  }

  /** The response body. */
  body(): Record<string, string | string[]> {
    return {
      schemas: [ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType === undefined ? {} : { scimType: this.scimType }),
      detail: this.message,
    };
  }
}

/** Shorthands for the common refusals. */
export const invalidValue = (detail: string) => new ScimError(400, detail, "invalidValue");
export const invalidSyntax = (detail: string) => new ScimError(400, detail, "invalidSyntax");
export const invalidFilter = (detail: string) => new ScimError(400, detail, "invalidFilter");
export const invalidPath = (detail: string) => new ScimError(400, detail, "invalidPath");
export const notFound = (what: string) => new ScimError(404, `${what} not found`);
export const uniqueness = (detail: string) => new ScimError(409, detail, "uniqueness");
