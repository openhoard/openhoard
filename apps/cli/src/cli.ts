import { readFileSync } from "node:fs";
import { pluginManifestSchema, validatePluginManifest } from "@openhoard/schemas";

// Works from both src/ (tests) and dist/ (published): package.json is one level up.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  readFile: (path: string) => string;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  readFile: (p) => readFileSync(p, "utf8"),
};

const usage = () => `openhoard ${pkg.version}

Usage:
  openhoard --version
  openhoard manifest validate <file...>   Validate plugin manifest(s) against schema v1
  openhoard manifest schema               Print the v1 manifest JSON Schema
`;

/** Runs the CLI and returns the process exit code. */
export function main(argv: string[], io: Io = defaultIo): number {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || ["-h", "--help", "help"].includes(cmd)) {
    io.out(usage());
    return 0;
  }
  if (["-v", "--version", "version"].includes(cmd)) {
    io.out(`${pkg.version}\n`);
    return 0;
  }
  if (cmd === "manifest" && sub === "schema") {
    io.out(`${JSON.stringify(pluginManifestSchema, null, 2)}\n`);
    return 0;
  }
  if (cmd === "manifest" && sub === "validate") return validateFiles(rest, io);
  io.err(`error: unknown command\n\n${usage()}`);
  return 2;
}

function validateFiles(files: string[], io: Io): number {
  if (files.length === 0) {
    io.err("error: give at least one manifest file\n");
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(io.readFile(file));
    } catch (e) {
      io.err(`✗ ${file}: cannot read JSON (${(e as Error).message})\n`);
      failed++;
      continue;
    }
    const { ok, errors } = validatePluginManifest(manifest);
    if (ok) {
      const m = manifest as { type: string; name: string };
      io.out(`✓ ${file}: valid ${m.type} "${m.name}"\n`);
    } else {
      failed++;
      io.err(`✗ ${file}\n${errors.map((x) => `    ${x}`).join("\n")}\n`);
    }
  }
  return failed ? 1 : 0;
}
