#!/usr/bin/env node
// Fails when a tracked text file contains invisible or bidirectional-control characters.
//
// These characters can make code read differently from how it runs ("Trojan Source",
// CVE-2021-42574) and they hide in diffs. OpenHoard's tests need them as DATA, so write them
// as escapes ("\u202e") instead, which reviewers can see.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Invisible or direction-changing: soft hyphen, combining grapheme joiner, Arabic letter mark,
// Hangul fillers, Khmer inherent vowels, Mongolian vowel separator, zero-width and bidi controls,
// line/paragraph separators (line terminators in JS), word joiners, BOM, halfwidth Hangul filler,
// Unicode tag characters and supplementary variation selectors (used to smuggle bytes).
const FORBIDDEN =
  // eslint-disable-next-line no-misleading-character-class -- each invisible code point is matched on its own, on purpose
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
// Basic variation selectors pick emoji or text style (the U+FE0F in a Markdown emoji), so one after
// a character is fine in prose. In code, or in runs (a smuggling channel), they are refused.
const SELECTOR = /[\ufe00-\ufe0f]/u;
const SELECTOR_RUN = /[\ufe00-\ufe0f]{2,}/u;
const PROSE = /\.(?:md|txt)$/;
// Text files by extension, extensionless files (LICENSE) and dotfiles (.gitignore, .npmrc).
const TEXT =
  /\.(?:[cm]?[jt]sx?|json|md|ya?ml|py|toml|txt|css|html?|svg|sh|ps1)$|(?:^|\/)[^./]+$|(?:^|\/)\.[^/]+$/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && TEXT.test(f));

let problems = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    const m =
      FORBIDDEN.exec(line) ??
      SELECTOR_RUN.exec(line) ??
      (PROSE.test(file) ? null : SELECTOR.exec(line));
    if (!m) return;
    const cp = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    console.error(
      `${file}:${i + 1}:${m.index + 1}: U+${cp} (invisible or bidi control); use an escape`,
    );
    problems++;
  });
}
if (problems) {
  console.error(`\n${problems} invisible or bidi-control character(s) found.`);
  process.exit(1);
}
console.log(`check-unicode: ${files.length} files clean`);
