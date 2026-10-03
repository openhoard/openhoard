import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TOOLS } from "./mcp.js";

/*
 * T-1210: what the listings are made from (the MCP registry's server.json, the Claude Code
 * plugin and its marketplace, the skills' zips) says what the server is, agrees with itself,
 * and stays within what each catalogue takes.
 */

const repo = new URL("../../../", import.meta.url);
const json = (path: string) =>
  JSON.parse(readFileSync(new URL(path, repo), "utf8")) as Record<string, unknown>;

interface Packaging {
  zip(files: { name: string; data: Buffer }[]): Buffer;
  skillNames(skillsDir?: string): string[];
  skillZip(name: string, skillsDir?: string): Buffer;
}
const packaging = (await import(new URL("scripts/package-skills.mjs", repo).href)) as Packaging;

describe("the MCP registry's server.json", () => {
  const server = json("server.json") as {
    name: string;
    description: string;
    version: string;
    title: string;
    remotes: { type: string; url: string; variables: Record<string, { isRequired: boolean }> }[];
  };

  it("is within the registry's limits, under the project's own namespace", () => {
    expect(server.name).toBe("io.github.openhoard/openhoard");
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names no endpoint of anyone's: the address is the person's own server", () => {
    expect(server.remotes).toHaveLength(1);
    const [remote] = server.remotes;
    expect(remote?.type).toBe("streamable-http");
    expect(remote?.url).toBe("https://{server_host}/mcp");
    expect(remote?.url).toMatch(/^https?:\/\/[^\s]+$/);
    expect(remote?.variables.server_host?.isRequired).toBe(true);
  });
});

describe("the tools, as a connector directory asks for them", () => {
  it("each have a title, and say whether they only read", () => {
    for (const tool of TOOLS) {
      expect(tool.title, tool.name).toMatch(/\S/);
      const hints = tool.annotations ?? {};
      expect(
        hints.readOnlyHint === true || typeof hints.destructiveHint === "boolean",
        tool.name,
      ).toBe(true);
    }
  });
});

describe("the Claude Code plugin", () => {
  const marketplace = json(".claude-plugin/marketplace.json") as {
    name: string;
    plugins: { name: string; source: string }[];
  };
  const plugin = json("skills/.claude-plugin/plugin.json") as {
    name: string;
    version: string;
    skills: string[];
    userConfig: Record<string, { required?: boolean }>;
    mcpServers: Record<string, { type: string; url: string }>;
  };

  it("is listed by the repository's marketplace, under one name", () => {
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: plugin.name, source: "./skills" }),
    ]);
    expect(plugin.name).toBe("openhoard");
    // The skills are the folders of skills/ itself.
    expect(plugin.skills).toEqual(["./"]);
  });

  it("asks for the person's own server, and connects to it", () => {
    // The whole address, typed once: nothing is joined to it, so a slash on the end of a
    // server's address can't make "//mcp" (which the server doesn't answer).
    expect(plugin.userConfig.mcp_url?.required).toBe(true);
    expect(plugin.mcpServers).toEqual({
      openhoard: { type: "http", url: "${user_config.mcp_url}" },
    });
  });

  it("has the same version as the other listings", () => {
    const versions = [plugin.version, json("server.json").version];
    expect(new Set(versions).size, versions.join(", ")).toBe(1);
  });
});

describe("the skills' zips", () => {
  /** A zip's entries, read back from its central directory. */
  function entries(zip: Buffer): { name: string; data: Buffer }[] {
    const end = zip.length - 22;
    expect(zip.subarray(end, end + 4).toString("latin1")).toBe("PK\u0005\u0006");
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    const out = [];
    for (let i = 0; i < count; i++) {
      expect(zip.subarray(at, at + 4).toString("latin1")).toBe("PK\u0001\u0002");
      expect(zip.readUInt16LE(at + 10), "stored").toBe(0);
      const packed = zip.readUInt32LE(at + 20);
      const nameLength = zip.readUInt16LE(at + 28);
      const local = zip.readUInt32LE(at + 42);
      const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
      // The file's own header says what the directory says, as unzip checks.
      expect(zip.subarray(local, local + 4).toString("latin1")).toBe("PK\u0003\u0004");
      expect(zip.subarray(local + 4, local + 30).equals(zip.subarray(at + 6, at + 32))).toBe(true);
      expect(zip.subarray(local + 30, local + 30 + nameLength).toString("utf8")).toBe(name);
      const dataAt = local + 30 + nameLength + zip.readUInt16LE(local + 28);
      const data = Buffer.from(zip.subarray(dataAt, dataAt + packed));
      expect(zip.readUInt32LE(at + 16), `${name}: crc`).toBe(crc32(data));
      expect(zip.readUInt32LE(at + 24), `${name}: size`).toBe(data.length);
      out.push({ name, data });
      at += 46 + nameLength;
    }
    return out;
  }

  it("hold each skill's folder, with its SKILL.md at the top of the folder", () => {
    const names = packaging.skillNames();
    expect(names).toEqual(["catch-me-up", "find-and-open", "who-can-see-this"]);
    for (const name of names) {
      const files = entries(packaging.skillZip(name));
      expect(files.map((f) => f.name)).toContain(`${name}/SKILL.md`);
      expect(files.every((f) => f.name.startsWith(`${name}/`))).toBe(true);
      const source = readFileSync(new URL(`skills/${name}/SKILL.md`, repo));
      expect(files.find((f) => f.name === `${name}/SKILL.md`)?.data.equals(source)).toBe(true);
    }
  });

  it("take folders with a SKILL.md only, and pack what isn't text whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-skills-"));
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0xff, 0x00, 0x0d, 0x0a]);
      for (const folder of ["one/assets", ".claude-plugin", "notes"]) {
        mkdirSync(join(dir, folder), { recursive: true });
      }
      writeFileSync(join(dir, "one/SKILL.md"), "---\nname: one\n---\n");
      writeFileSync(join(dir, "one/assets/shape.png"), bytes);
      writeFileSync(join(dir, ".claude-plugin/SKILL.md"), "not a skill");
      writeFileSync(join(dir, "notes/README.md"), "no SKILL.md here");
      writeFileSync(join(dir, "README.md"), "a file, not a folder");
      expect(packaging.skillNames(dir)).toEqual(["one"]);
      const files = entries(packaging.skillZip("one", dir));
      expect(files.map((f) => f.name)).toEqual(["one/SKILL.md", "one/assets/shape.png"]);
      expect(files[1]?.data.equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trip any file, named in UTF-8, as the same bytes on every machine", () => {
    const files = [
      { name: "a/caf\u00e9.md", data: Buffer.from("x".repeat(5000)) },
      { name: "a/empty", data: Buffer.alloc(0) },
    ];
    const zip = packaging.zip(files);
    expect(entries(zip)).toEqual(files);
    // Nothing of the machine or the day is in it: a release's zip can be checked against the
    // source.
    expect(createHash("sha256").update(zip).digest("hex")).toBe(
      "0c340104091bd9e31c250bb47d54e67e32e755ebeac0b2838edee4d8a7bab71c",
    );
  });

  it("refuse a link in a skill rather than leave it out", () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-skills-"));
    try {
      mkdirSync(join(dir, "one"));
      writeFileSync(join(dir, "one/SKILL.md"), "---\nname: one\n---\n");
      try {
        symlinkSync(join(dir, "one/SKILL.md"), join(dir, "one/also.md"));
      } catch {
        return; // Windows without the right to make links: nothing to test.
      }
      expect(() => packaging.skillZip("one", dir)).toThrow(/neither a file nor a folder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
