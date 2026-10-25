import { parseArgs } from "node:util";

/*
 * The server and its operator commands (T-1407): one `openhoard` binary. bin.ts runs them.
 *
 *   openhoard [--data-dir <dir>] serve        the server (@openhoard/server's main.js)
 *   openhoard [--data-dir <dir>] admin …      admin commands (apps/server admin.ts)
 *   openhoard [--data-dir <dir>] init --solo  a one-person setup (solo.ts); --team a team's (team.ts)
 *   openhoard [--data-dir <dir>] connect …    an AI client's config (connect.ts)
 *   openhoard [--data-dir <dir>] tunnel       the server behind a Cloudflare tunnel (tunnel.ts)
 *   openhoard [--data-dir <dir>] service …    the server as this machine's service (service.ts)
 *
 * The command is the first argument that isn't an option (`--data-dir x admin …` is admin too).
 * The server's package is loaded only for these, so `manifest` stays light.
 */

const COMMANDS = new Set(["serve", "admin", "init", "connect", "tunnel", "service"]);

/**
 * The command `args` name, and where: the first argument that isn't an option, when it is one
 * of the server's; null otherwise (`--data-dir admin` is a directory named admin).
 */
export function operatorCommand(args: readonly string[]): { value: string; index: number } | null {
  const first = parseArgs({
    args: [...args],
    options: { "data-dir": { type: "string" } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  }).tokens.find((t) => t.kind === "positional");
  return first?.kind === "positional" && COMMANDS.has(first.value)
    ? { value: first.value, index: first.index }
    : null;
}
