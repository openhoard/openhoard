/*
 * What the token and Graph requests share: reading an answer up to a limit, and reading how
 * long a busy server asks to wait.
 */

/** Reads a response's text, up to a limit; undefined when it is longer. */
export async function textOf(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body.cancel().catch(() => undefined);
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A response's JSON object, read up to a limit; {} when it is longer or isn't an object. */
export async function objectOf(
  response: Response,
  limit: number,
): Promise<Record<string, unknown>> {
  const text = await textOf(response, limit);
  try {
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // not JSON (a proxy's page): the caller decides by the status
  }
}

/** A Retry-After header in milliseconds: seconds, or a date. Undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** The name of whatever was thrown, when it has one. */
export const nameOf = (e: unknown): string =>
  typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string"
    ? (e as { name: string }).name
    : "";
