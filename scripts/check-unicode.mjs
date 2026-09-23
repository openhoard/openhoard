#!/usr/bin/env node
// Fails when a tracked text file contains invisible or bidirectional-control characters.
//
// These characters can make code read differently from how it runs ("Trojan Source",
// CVE-2021-42574) and they hide in diffs. OpenHoard's tests need them as DATA, so write them
// as escapes ("\u202e") instead, which reviewers can see.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FORBIDDEN =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;
const TEXT = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|py|toml|txt|css|html?|svg|sh|ps1)$|(?:^|\/)[^.]+$/;

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
    const m = FORBIDDEN.exec(line);
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
