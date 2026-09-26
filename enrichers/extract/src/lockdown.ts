import Module, { isBuiltin, registerHooks } from "node:module";

/*
 * The first thing the extractor's child process runs, before any parser is loaded: it takes
 * away every Node built-in the parsers don't need, so that code running over a hostile file
 * can't reach the network, start code from strings or change how modules load, even if it were
 * subverted.
 *
 * Node 24's permission model (the child runs with `--permission`) already limits reading files
 * to the extractor's own code, and forbids writing files, child processes, worker threads,
 * native addons, WASI, the inspector and `process.binding()`. It has no switch for the network
 * (`--allow-net` arrives in Node 25). So, in-process:
 *
 * - built-ins are an allowlist ({@link ALLOWED}): anything else, by import, require, a
 *   package's `imports` map or process.getBuiltinModule(), is refused. That covers the network
 *   (net, tls, http, https, http2, dgram, dns and their `_http_*`/`_tls_*` internals), `vm`
 *   (which evaluates strings in a new context, past `--disallow-code-generation-from-strings`),
 *   `module` (whose registerHooks() could get ahead of this hook), `repl`, `sqlite`, `wasi`,
 *   `inspector`, `trace_events`, `child_process`, `worker_threads` and `cluster`;
 * - Module.registerHooks and Module.register, reachable from any CommonJS module as
 *   `module.constructor`, are replaced by functions that throw, and so are process.binding,
 *   process._linkedBinding and process.dlopen;
 * - fetch, WebSocket and EventSource are removed from the global scope.
 *
 * What remains is only what Node's own modules reach internally. The host can add the hard
 * boundary (a firewall rule or network namespace for the service user); the README says so.
 */

/** The built-ins the parsers and the extractor use (`node:` prefix or not, subpaths listed). */
export const ALLOWED: ReadonlySet<string> = new Set([
  "buffer",
  "events",
  "fs",
  "fs/promises",
  "path",
  "stream",
  "stream/promises",
  "string_decoder",
  "url",
  "util",
  "zlib",
]);

/** Whether a built-in module specifier is refused (anything that isn't a built-in is not). */
export function isRefusedBuiltin(specifier: string): boolean {
  if (!isBuiltin(specifier)) return false;
  return !ALLOWED.has(specifier.startsWith("node:") ? specifier.slice(5) : specifier);
}

export class BlockedModuleError extends Error {
  constructor(specifier: string) {
    super(`the extractor may not load ${specifier}`);
    this.name = "BlockedModuleError";
  }
}

const refuse = (what: string) => () => {
  throw new BlockedModuleError(what);
};

function replace(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: false, configurable: false });
}

/** Applies the lockdown to this process. Irreversible; for the child process only. */
export function lockDown(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (isRefusedBuiltin(specifier)) throw new BlockedModuleError(specifier);
      const resolved = next(specifier, context);
      // A package's `imports` map can name a built-in too.
      if (resolved.url.startsWith("node:") && isRefusedBuiltin(resolved.url)) {
        throw new BlockedModuleError(resolved.url);
      }
      return resolved;
    },
  });
  replace(Module, "registerHooks", refuse("module.registerHooks"));
  replace(Module, "register", refuse("module.register"));
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  replace(process, "getBuiltinModule", (id: string) => {
    if (typeof id !== "string" || isRefusedBuiltin(id)) throw new BlockedModuleError(String(id));
    return getBuiltinModule(id);
  });
  for (const name of ["binding", "_linkedBinding", "dlopen"]) {
    replace(process, name, refuse(`process.${name}`));
  }
  for (const name of ["fetch", "WebSocket", "EventSource"]) {
    Reflect.deleteProperty(globalThis, name);
  }
}
