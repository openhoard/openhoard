import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, type Io } from "./cli.js";

function run(argv: string[], files: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const io: Io = {
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error("ENOENT");
      return f;
    },
  };
  return { code: main(argv, io), out, err };
}

const good = JSON.stringify({
  manifest_version: 1,
  name: "connector-s3",
  version: "0.0.1",
  type: "connector",
  capabilities: ["read:content"],
});

describe("openhoard CLI", () => {
  it("prints usage and version", () => {
    expect(run([]).out).toMatch(/Usage:/);
    expect(run(["--version"]).out).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints the schema", () => {
    expect(JSON.parse(run(["manifest", "schema"]).out).title).toMatch(/plugin manifest/i);
  });

  it("validates good, bad and unreadable manifests", () => {
    const bad = JSON.stringify({ ...JSON.parse(good), capabilities: ["share"] });
    const r = run(["manifest", "validate", "good.json", "bad.json", "missing.json"], {
      "good.json": good,
      "bad.json": bad,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✓ good.json: valid connector "connector-s3"/);
    expect(r.err).toMatch(/✗ bad.json/);
    expect(r.err).toMatch(/cannot read JSON/);
  });

  it("returns 0 when all manifests are valid", () => {
    expect(run(["manifest", "validate", "g.json"], { "g.json": good }).code).toBe(0);
  });

  it("rejects missing args and unknown commands", () => {
    expect(run(["manifest", "validate"]).code).toBe(2);
    expect(run(["nope"]).code).toBe(2);
  });
});

describe("default IO", () => {
  it("writes to stdout/stderr and reads real files", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "oh-cli-"));
    const file = join(dir, "m.json");
    writeFileSync(file, good);
    try {
      expect(main(["manifest", "validate", file])).toBe(0);
      expect(main(["nope"])).toBe(2);
      expect(out).toHaveBeenCalledWith(expect.stringContaining("valid connector"));
      expect(err).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
