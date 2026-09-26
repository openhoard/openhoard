import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../mcp.js";

/*
 * T-806: the repository's skills (skills/<name>/SKILL.md) are valid Agent Skills and name only
 * tools this server serves, so a renamed tool can't leave a skill calling nothing.
 */

const root = new URL("../../../../skills/", import.meta.url);
const skills = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("skills/", () => {
  it("has the v0 skills", () => {
    expect(skills).toEqual(
      expect.arrayContaining(["catch-me-up", "find-and-open", "who-can-see-this"]),
    );
  });

  for (const name of skills) {
    it(`${name}: front matter, and only tools the server serves`, () => {
      const text = readFileSync(new URL(`${name}/SKILL.md`, root), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(m, "front matter").not.toBeNull();
      const fields = Object.fromEntries(
        (m?.[1] ?? "").split("\n").map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
      );
      expect(fields.name).toBe(name);
      expect(fields.name).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(fields.description?.length ?? 0).toBeGreaterThan(20);
      expect(fields.description?.length ?? 0).toBeLessThanOrEqual(1024);
      const served = new Set(TOOLS.map((t) => t.name));
      const named = [...text.matchAll(/OpenHoard's `(\w+)`|call(?:s)? `(\w+)`/g)].map(
        (x) => x[1] ?? x[2],
      );
      expect(named.length, "names at least one tool").toBeGreaterThan(0);
      for (const tool of named) expect(served.has(tool as string), tool).toBe(true);
    });
  }
});
