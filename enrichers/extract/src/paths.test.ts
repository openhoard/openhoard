import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantsFor, UnsafeInstallError } from "./paths.ts";

/*
 * What the child may read, on installs laid out the way npm lays them out (hoisted: every
 * package in one node_modules): only the libraries' own folders, never the node_modules
 * folder, and never through a link that leads elsewhere.
 */

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pkg(dir: string, name: string, dependencies: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies }));
  writeFileSync(join(dir, "index.js"), "");
  return dir;
}

/** app/node_modules/{@openhoard/enricher-extract, yauzl, pend, other, @openhoard/secret}. */
function hoisted() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "openhoard-hoisted-")));
  const modules = join(root, "app", "node_modules");
  const extract = pkg(
    join(modules, "@openhoard", "enricher-extract"),
    "@openhoard/enricher-extract",
  );
  mkdirSync(join(extract, "dist"));
  const yauzl = pkg(join(modules, "yauzl"), "yauzl", { pend: "1" });
  const pend = pkg(join(modules, "pend"), "pend");
  pkg(join(modules, "other"), "other");
  pkg(join(modules, "@openhoard", "secret"), "@openhoard/secret");
  return { modules, extract, yauzl, pend, dist: join(extract, "dist") };
}

describe("grantsFor", () => {
  it("grants the libraries' folders in a hoisted install, not node_modules", () => {
    const { modules, extract, yauzl, pend, dist } = hoisted();
    const grants = grantsFor(dist, extract, ["yauzl"]);
    expect(grants).toContain(dist);
    expect(grants).toContain(yauzl);
    expect(grants).toContain(pend);
    expect(grants).toContain(join(extract, "package.json"));
    expect(grants).not.toContain(modules);
    expect(grants).not.toContain(extract);
    expect(grants.some((g) => g.includes("other") || g.includes("secret"))).toBe(false);
    // The paths Node tries before it finds yauzl are granted too (they don't exist).
    expect(grants).toContain(join(dist, "node_modules", "yauzl"));
  });

  it("refuses a link that leads out of the grant", () => {
    const { yauzl, extract, dist } = hoisted();
    symlinkSync(join(root, "app"), join(yauzl, "escape"), "junction");
    expect(() => grantsFor(dist, extract, ["yauzl"])).toThrow(UnsafeInstallError);
  });

  it("follows a package manager's links into the grant, and refuses one that leads elsewhere", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "openhoard-linked-")));
    const store = pkg(join(root, "store", "saxes"), "saxes");
    const extract = pkg(join(root, "pkg"), "@openhoard/enricher-extract");
    mkdirSync(join(extract, "dist"));
    mkdirSync(join(extract, "node_modules"));
    symlinkSync(store, join(extract, "node_modules", "saxes"), "junction");
    const grants = grantsFor(join(extract, "dist"), extract, ["saxes"]);
    expect(grants).toContain(store);
    expect(grants).toContain(join(extract, "node_modules", "saxes"));
    // A link in the code folder to somewhere else is refused.
    symlinkSync(join(root, "store"), join(extract, "dist", "store"), "junction");
    expect(() => grantsFor(join(extract, "dist"), extract, ["saxes"])).toThrow(UnsafeInstallError);
  });

  it("skips a library that isn't installed", () => {
    const { extract, dist } = hoisted();
    expect(grantsFor(dist, extract, ["nowhere"])).toContain(dist);
  });
});
