#!/usr/bin/env node
// Packs each skill in skills/ as the zip Claude takes (Settings → Capabilities → Skills → Upload
// skill): the skill's folder, with its SKILL.md at the top of the folder. Writes
// dist/skills/<name>.zip, the same bytes for the same files (stored, not compressed; no times;
// sorted names), so a release's zips can be checked against the source.
//
//   node scripts/package-skills.mjs [--out <dir>]
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
function filesUnder(dir) {
  const out = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
      // A link or a device would be left out without a word: say so instead.
      else throw new Error(`${full} is neither a file nor a folder: a skill is packed as files`);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * A zip archive of `files` ({ name, data }), stored as they are (skills are small, and stored
 * bytes don't depend on the zlib a machine has), with a fixed date (1980-01-01) and no extra
 * fields: a plain archive any unzip reads. Names are UTF-8 (flag bit 11). No zip64: an archive
 * that would need it is refused.
 */
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  if (files.length >= 0xffff) throw new Error(`${files.length} files are too many for a zip`);
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > 0xffff) throw new Error(`the name ${name} is too long for a zip`);
    if (offset + data.length >= 0xffffffff) throw new Error(`${name} makes the zip too large`);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // version needed
    common.writeUInt16LE(0x0800, 2); // UTF-8 names
    common.writeUInt16LE(0, 4); // stored
    common.writeUInt16LE(0, 6); // time
    common.writeUInt16LE(0x0021, 8); // date: 1980-01-01
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(data.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    common.writeUInt16LE(0, 24); // extra
    const local = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), common, nameBytes, data]);
    const entry = Buffer.alloc(46);
    entry.write("PK\x01\x02", 0, "latin1");
    entry.writeUInt16LE(20, 4); // version made by
    common.copy(entry, 6);
    // comment length, disk, internal and external attributes: zero
    entry.writeUInt32LE(offset, 42);
    locals.push(local);
    central.push(Buffer.concat([entry, nameBytes]));
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.write("PK\x05\x06", 0, "latin1");
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The skills in skills/: each folder that holds a SKILL.md. */
export function skillNames(skillsDir = join(root, "skills")) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) =>
      statSync(join(skillsDir, name, "SKILL.md"), { throwIfNoEntry: false })?.isFile(),
    )
    .sort();
}

/** One skill's zip: `<name>/…`, every file of its folder. */
export function skillZip(name, skillsDir = join(root, "skills")) {
  const dir = join(skillsDir, name);
  return zip(
    // The bytes as they are in the checkout (.gitattributes keeps text LF on every machine),
    // so a script or an image in a skill is packed whole.
    filesUnder(dir).map((file) => ({
      name: `${name}/${file}`,
      data: readFileSync(join(dir, file)),
    })),
  );
}

/** Whether this file is what `node` was asked to run (through a link or not), not imported. */
function isProgram() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProgram()) {
  const at = process.argv.indexOf("--out");
  if (at > 0 && !process.argv[at + 1]) {
    console.error("usage: node scripts/package-skills.mjs [--out <dir>]");
    process.exit(2);
  }
  const out = at > 0 ? process.argv[at + 1] : join(root, "dist", "skills");
  mkdirSync(out, { recursive: true });
  for (const name of skillNames()) {
    const bytes = skillZip(name);
    writeFileSync(join(out, `${name}.zip`), bytes);
    console.log(`${join(out, `${name}.zip`)}  ${bytes.length} bytes`);
  }
}
