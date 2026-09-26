import { lockDown } from "./lockdown.ts";

/*
 * Run by sandbox.test.ts as the child, with the sandbox's own options, in place of child.ts:
 * it locks down as child.ts does, then tries everything a subverted parser might, and prints
 * what worked as one line of JSON.
 */

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
const secret = process.env.PROBE_SECRET ?? "";
await attempt("read-outside", () => fs.readFileSync(secret, "utf8"));
await attempt("write", () => fs.writeFileSync(`${secret}.written`, "x"));
await attempt("import-net", () => import("node:net"));
await attempt("import-http", () => import("node:http"));
await attempt("import-dns", () => import("dns/promises"));
await attempt("builtin-tls", () => process.getBuiltinModule("node:tls"));
await attempt("child-process", () => import("node:child_process"));
await attempt("worker", () => import("node:worker_threads"));
await attempt(
  "fetch",
  () =>
    (globalThis as unknown as { fetch?: () => unknown }).fetch?.() ??
    Promise.reject(new TypeError("gone")),
);
await attempt("binding", () =>
  (process as unknown as { binding(n: string): unknown }).binding("tcp_wrap"),
);
await attempt("eval", () => new Function("return 1")());
await attempt("env", () => {
  if (Object.keys(process.env).some((k) => k !== "PROBE_SECRET" && k !== "SystemRoot")) {
    throw Object.assign(new Error("leaked"), { code: "LEAKED" });
  }
});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
