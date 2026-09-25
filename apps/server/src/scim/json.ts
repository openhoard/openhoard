import { invalidSyntax, invalidValue } from "./errors.js";

/*
 * Reading SCIM JSON. Attribute names are case-insensitive (RFC 7643 section 2.1), so fields are
 * looked up without regard to case; values are checked for their type, and a wrong one is an
 * invalidValue (400) naming the attribute.
 */

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `obj`'s field `name`, matched without regard to case; undefined when absent. */
export function field(obj: Json, name: string): unknown {
  if (Object.hasOwn(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** A string attribute, or null when absent or null. */
export function text(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw invalidValue(`${name} must be a string`);
  return v;
}

/**
 * A boolean attribute. Entra (without the aadOptscim062020 flag) sends `active` as the strings
 * "True" and "False", so those count too.
 */
export function bool(v: unknown, name: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  throw invalidValue(`${name} must be true or false`);
}

/** The request body as a JSON object, or invalidSyntax (400). */
export function parseBody(raw: string): Json {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw invalidSyntax("the body is not JSON");
  }
  if (!isObject(body)) throw invalidSyntax("the body must be a JSON object");
  return body;
}

/** Refuses a body whose `schemas` doesn't name `schema` (RFC 7644: schemas is required). */
export function requireSchema(body: Json, schema: string): void {
  const schemas = field(body, "schemas");
  if (
    !Array.isArray(schemas) ||
    !schemas.some((s) => typeof s === "string" && s.toLowerCase() === schema.toLowerCase())
  ) {
    throw invalidSyntax(`schemas must include ${schema}`);
  }
}
