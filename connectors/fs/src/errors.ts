import {
  ConnectorError,
  isAbortError,
  isConnectorError,
  type ConnectorErrorCode,
} from "@openhoard/sdk";

/*
 * File system errors as the connector contract's codes. The message names the OS error code
 * only, never the path: a path can say more about a file than its reader may know, and messages
 * reach logs and admins' screens.
 */

const CODES: Record<string, ConnectorErrorCode> = {
  ENOENT: "not-found",
  ENOTDIR: "not-found",
  ELOOP: "not-found",
  EACCES: "permanent",
  EPERM: "permanent",
  EISDIR: "permanent",
  ENAMETOOLONG: "permanent",
  EINVAL: "permanent",
  // Everything else (EBUSY, EMFILE, ENFILE, EAGAIN, EIO, ETIMEDOUT, ESTALE, a network drive
  // going away…) is the moment's: try again.
};

/** `e` as a ConnectorError (a cancellation or a ConnectorError passes through unchanged). */
export function fsError(e: unknown): unknown {
  if (isConnectorError(e) || isAbortError(e)) return e;
  const errno = (e as { code?: unknown } | null)?.code;
  const code =
    typeof errno === "string" && Object.hasOwn(CODES, errno)
      ? (CODES[errno] as ConnectorErrorCode)
      : "retryable";
  const label = typeof errno === "string" && /^E[A-Z0-9]{1,20}$/.test(errno) ? errno : "unknown";
  const call = (e as { syscall?: unknown } | null)?.syscall;
  const during = typeof call === "string" && /^[a-z]{1,20}$/.test(call) ? ` (${call})` : "";
  // No cause: the original error's message holds the path.
  return new ConnectorError(code, `file system error ${label}${during}`);
}
