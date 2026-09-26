import { registerHooks } from "node:module";

/*
 * The first thing the extractor's child process runs, before any parser is loaded: it takes
 * away the network and process APIs a parser has no use for, so that code running over a
 * hostile file can't reach out even if it were subverted.
 *
 * Node 24's permission model (the child runs with `--permission`) already limits reading files
 * to the extractor's own code, and forbids writing files, child processes, worker threads,
 * native addons, WASI, the inspector and `process.binding()`. It has no switch for the network
 * (`--allow-net` arrives in Node 25). So, as the best that can be done in-process:
 *
 * - the networking built-ins (net, tls, dgram, dns, http, https, http2) and the process ones
 *   (child_process, cluster, worker_threads, inspector) can't be imported or required, nor
 *   reached through process.getBuiltinModule();
 * - fetch, WebSocket and EventSource are removed from the global scope.
 *
 * What remains possible is only what core modules reach internally. The host can add the hard
 * boundary (a firewall rule or network namespace for the service user); SECURITY notes in the
 * README say so.
 */

const BLOCKED = new Set([
  "net",
  "tls",
  "dgram",
  "dns",
  "http",
  "https",
  "http2",
  "child_process",
  "cluster",
  "worker_threads",
  "inspector",
]);

/** Whether a module specifier names a blocked built-in (`net`, `node:dns/promises`…). */
export function isBlockedBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const slash = bare.indexOf("/");
  return BLOCKED.has(slash === -1 ? bare : bare.slice(0, slash));
}

export class BlockedModuleError extends Error {
  constructor(specifier: string) {
    super(`the extractor may not load ${specifier}`);
    this.name = "BlockedModuleError";
  }
}

/** Applies the lockdown to this process. Irreversible; for the child process only. */
export function lockDown(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (isBlockedBuiltin(specifier)) throw new BlockedModuleError(specifier);
      return next(specifier, context);
    },
  });
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  Object.defineProperty(process, "getBuiltinModule", {
    value: (id: string) => {
      if (isBlockedBuiltin(id)) throw new BlockedModuleError(id);
      return getBuiltinModule(id);
    },
    writable: false,
    configurable: false,
  });
  for (const name of ["fetch", "WebSocket", "EventSource"]) {
    Reflect.deleteProperty(globalThis, name);
  }
}
