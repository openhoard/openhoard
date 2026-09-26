import { createRequire } from "node:module";
import { lockDown } from "./lockdown.ts";

/*
 * Run by sandbox.test.ts as the child, with the sandbox's own options, in place of child.ts:
 * it locks down as child.ts does, then tries everything a subverted parser might, and prints
 * what worked as one line of JSON. `require` is taken before the lockdown, as a module loaded
 * earlier could have.
 */

const require = createRequire(import.meta.url);
lockDown();
const outcome: Record<string, string> = {};
async function attempt(name: string, action: () => unknown): Promise<void> {
  try {
    await action();
    outcome[name] = "allowed";
  } catch (e) {
    outcome[name] = (e as { code?: string }).code ?? (e as Error).name;
  }
}

const fs = await import("node:fs");
const env = (name: string) => process.env[name] ?? "";
await attempt("read-outside", () => fs.readFileSync(env("PROBE_SECRET"), "utf8"));
await attempt("read-sibling-package", () => fs.readFileSync(env("PROBE_SIBLING"), "utf8"));
await attempt("read-package-root", () => fs.readFileSync(env("PROBE_PACKAGE_FILE"), "utf8"));
await attempt("write", () => fs.writeFileSync(`${env("PROBE_SECRET")}.written`, "x"));
const refused = [
  "node:net",
  "node:http",
  "https",
  "http2",
  "dgram",
  "dns/promises",
  "_http_client",
  "_http_agent",
  "_http_common",
  "_tls_wrap",
  "node:tls",
  "node:vm",
  "node:module",
  "repl",
  "node:sqlite",
  "wasi",
  "trace_events",
  "inspector",
  "child_process",
  "worker_threads",
  "cluster",
];
for (const m of refused) {
  await attempt(`import:${m}`, () => import(m));
  await attempt(`require:${m}`, () => require(m));
  await attempt(`builtin:${m}`, () => process.getBuiltinModule(m));
}
// Through variables: TypeScript would look for these modules.
const dataUrl = "data:text/javascript,export default 1";
const httpUrl = "http://127.0.0.1:9/x.js";
await attempt("import-data-url", () => import(dataUrl));
await attempt("import-http-url", () => import(httpUrl));
await attempt("wasm", () => {
  if ("WebAssembly" in globalThis) return;
  throw new TypeError("gone");
});
await attempt("allowed:zlib", () => import("node:zlib"));
await attempt("allowed:require-stream", () => require("stream"));
await attempt(
  "fetch",
  () =>
    (globalThis as unknown as { fetch?: () => unknown }).fetch?.() ??
    Promise.reject(new TypeError("gone")),
);
const p = process as unknown as Record<string, (...a: unknown[]) => unknown>;
await attempt("binding", () => p.binding?.("tcp_wrap"));
await attempt("linked-binding", () => p._linkedBinding?.("anything"));
await attempt("dlopen", () => p.dlopen?.({ exports: {} }, "/nonexistent.node"));
await attempt("eval", () => new Function("return 1")());
// The environment's variable names, for the test to judge by platform.
outcome["env-keys"] = Object.keys(process.env).sort().join(",");
// Through a variable: TypeScript has no types for the .cjs probe, and needs none.
const cjsProbe = "./probe-cjs.fixtures.cjs";
const cjs = (await import(cjsProbe)) as {
  default: (attempt: (name: string, action: () => unknown) => Promise<void>) => Promise<void>[];
};
await Promise.all(cjs.default(attempt));
process.stdout.write(`${JSON.stringify(outcome)}\n`);
