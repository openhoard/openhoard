# @openhoard/enricher-extract

Text extraction (T-402) for plain text, Markdown, CSV/TSV, Word, Excel, PowerPoint and PDF, in
a limited child process. core/jobs runs it as the `extract-text` enrichment step and stores what
it finds per version (core/catalog `version_extracts`).

```ts
import { extract } from "@openhoard/enricher-extract";

const result = await extract(stream, { mime: "application/pdf", name: "invoice.pdf" }, { size });
if (result.ok)
  result.extraction; // { kind, text, truncated, metadata, signals, warnings }
else result.failure; // "malformed", "timeout", "archive-limits"… and result.permanent
```

`extract()` never throws for anything a file can cause: a crash, a hang, a zip bomb or garbage
comes back as a typed failure, and the process that asked goes on. It rejects only when its
signal aborts or its limits are invalid.

## What comes out

| Kind       | Text                                                              | Metadata                                              |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `text`     | decoded (UTF-8, UTF-16 with a BOM, else Windows-1252)             | encoding                                              |
| `markdown` | as written, without HTML comments                                 | encoding                                              |
| `csv`      | rows, cells separated by tabs                                     | delimiter, header, columns (name, type), exact `rows` |
| `docx`     | body, headers, footers, footnotes, endnotes; a paragraph per line | title, author                                         |
| `xlsx`     | each visible sheet: its name, then a row per line, cells by tabs  | title, author, sheets (name, state)                   |
| `pptx`     | each shown slide in order, then its speaker notes                 | title, author, slides                                 |
| `pdf`      | page by page, a line per text line                                | title, author, exact `pages`                          |

Text is capped (`maxTextBytes`, 1 MiB by default; `truncated` says when there was more) and
sanitized: control characters other than tab and newline removed, other line breaks turned
into newlines, invisible characters removed (zero-width space, bidi overrides and isolates,
Unicode tag characters…; the joiners and marks real scripts need stay), well-formed Unicode.
Title and author come from inside the file: they are content, like the text.

The kind is what the bytes are: a PDF named `.docx` is read as a PDF (warning `type-mismatch`).
Text types are read only when the media type or extension says so; untyped bytes
(`application/octet-stream`) are tried as PDF or Office only. Other types (images, video,
archives) answer `unsupported` without a process or a byte read.

**Signals** (for injection flagging, T-408) count text a reader wouldn't see, with a sample of
the first. What can be told apart safely is left out of `text`; the rest stays in:

| Left out                                                                                                             | Kept, and signalled                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Word hidden runs (`w:vanish`), tracked deletions, comments                                                           | white text, text of 1 pt or less                                                           |
| hidden and very hidden sheets, defined names, Excel comments                                                         | formulas (their values are kept), CSV cells that look like formulas                        |
| hidden slides, PowerPoint comments                                                                                   | PDF text drawn invisibly (render mode 3/7: OCR layers use it), white, tiny or off the page |
| HTML comments in Markdown, PDF annotations, document properties beyond title and author, embedded files (not opened) |                                                                                            |

Not resolved yet: Word character styles that hide text, and anything a renderer would hide by
layout (text under a shape, same colour as a shaded background).

## Failures

Permanent (the file's own; enrichment records `failed` and moves on): `unsupported`,
`malformed`, `encrypted`, `binary`, `too-large`, `archive-limits`, `xml-limits`,
`record-too-large`, `timeout`, `memory-limit`, `output-too-large`, `crashed`, `protocol`.
Transient (enrichment retries): `spawn-failed`; `killed`: the child ended without an answer
because something outside it ended it (the host's out-of-memory killer, an operator). On Linux
and macOS that is a signal the parent didn't send; on Windows, where TerminateProcess leaves
exit code 1, it is exit code 1, which the child itself never uses (its own uncaught errors
exit 71, `crashed`). Enrichment tries once more, then takes it as the file's. And
`input-failed`: the source failed part way, ran out the clock (the child waited on it and it
sent nothing for half the time limit, at most 30 s), or sent more or fewer bytes than the
content's `size`. The child is then killed before it sees the end of its input, so it never
answers for part of a file.

**An early answer waits for the source's checks.** Some extractions answer from the start of a
file (plain text stops at its limit). The rest of the source is still read to its end, in the
time left and never past `size`, without being sent anywhere, so the size check and the
source's own (blobContentSource() hashes the bytes and fails at the end of a mismatch) decide
before the answer counts: a failure there, or no end in time, is `input-failed`.

However an extraction ends, the content is closed: its iterator is returned, and a stream with
`destroy()` (a Node Readable) is destroyed, even one stalled mid-read. core/jobs also gives each
attempt's ContentSource a signal it aborts when the attempt ends.

## The sandbox

`extract()` starts `node` (process.execPath) on `child.js` with the content on stdin (streamed,
with backpressure) and reads one line of JSON from its stdout. The parent checks that answer
field by field (`schema.ts`: known keys only, enums, sizes, every string exactly as the
sanitizer leaves it); anything else is `protocol`.

| Limit    | Default                                                          | Enforced by                                                                                                                                               |
| -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| time     | 30 s + 100 ms per MiB, at most 10 min                            | the parent: SIGKILL at the deadline (TerminateProcess on Windows)                                                                                         |
| memory   | 768 MiB resident, 512 MiB JS heap                                | V8 (`--max-old-space-size`); the child's watchdog (every 50 ms, and as parsers read); on Linux also the parent, reading `/proc/<pid>/status` every 250 ms |
| input    | 256 MiB for PDF and Office (parsed whole)                        | the child; text and CSV stream with no limit (a 1 GiB CSV is fine)                                                                                        |
| output   | 2 × text limit + metadata                                        | the parent stops reading and kills past it                                                                                                                |
| archives | 10,000 entries, 512 MiB inflated, ratio 500 for parts over 1 MiB | the child, before and while inflating (yauzl checks bytes against declared sizes)                                                                         |
| XML      | no DOCTYPE, depth 256                                            | the child (saxes expands no entities beyond XML's own five)                                                                                               |
| CSV      | 1 MiB per record                                                 | the child (csv-parse `max_record_size`)                                                                                                                   |

What the child may do, per Node 24's permission model (`--permission`), the same on Linux,
macOS and Windows (the tests check each):

- read only its code folder (`dist/`, or `src/` in this package's tests), this package's
  `package.json`, and each library's own package folder with the paths Node's resolver looks
  at to find it (`--allow-fs-read`; `paths.ts`): not the package root, not a whole
  `node_modules` (in a hoisted npm install that is every package the server has), no
  configuration, data folder, blob store, home or temp files; write nothing. Node's permission
  model follows symbolic links, so every granted folder is walked once and a link that leads
  outside the grant (a workspace package linked into `node_modules`, say) stops the sandbox
  from starting: `extract()` rejects with UnsafeInstallError;
- no child processes, worker threads, native addons (`--no-addons` too), WASI, inspector, or
  `process.binding()` (and the lockdown replaces `process.binding`, `_linkedBinding` and
  `dlopen` with functions that throw);
- no `eval` or `new Function` (`--disallow-code-generation-from-strings`), no `__proto__`
  (`--disable-proto=delete`);
- an environment with only its settings: none of the server's variables (no database URL, no
  keys). The platform adds what it adds to every process: on macOS CoreFoundation's
  `__CF_USER_TEXT_ENCODING`; on Windows libuv's required variables (`SYSTEMROOT`, `PATH`,
  `TEMP`, `USERNAME`, `USERPROFILE`, `WINDIR`…), copied from the server's when missing: names,
  paths and the user, never the application's settings. The tests check exactly that per
  platform.

**Built-ins: an allowlist.** Before any parser loads, the child's lockdown (`lockdown.ts`)
lets it load only the built-ins the parsers use: `buffer`, `events`, `fs`, `fs/promises`,
`path`, `stream`, `stream/promises`, `string_decoder`, `url`, `util`, `zlib`. Every other one is
refused, by import, require (`module.constructor._load` included), a package's `imports` map
or `process.getBuiltinModule()`: the network (`net`, `tls`, `dgram`, `dns`, `http`, `https`,
`http2` and the `_http_*`, `_tls_*` internals), `vm` (which evaluates strings in a new context,
past `--disallow-code-generation-from-strings`), `module` (whose registerHooks() could get
ahead of the lockdown's hook; `Module.registerHooks` and `Module.register` are also replaced),
`repl`, `sqlite`, `wasi`, `trace_events`, `inspector`, `child_process`, `worker_threads`,
`cluster`, `v8`, `os`, `crypto`… Modules resolve only to `file:` URLs and allowed built-ins:
never `data:` (code from a string), `http:`, `blob:` or another scheme. `fetch`, `WebSocket`,
`EventSource` and `WebAssembly` are removed from the global scope (V8's `--no-expose-wasm`
isn't in Node 24's V8, which refuses the option, so the global is deleted instead; pdf.js runs
with its WebAssembly decoders off). The tests try each of these in a real child.

**Network, best effort.** Node 24's permission model has no network switch (`--allow-net`
comes in Node 25), so the allowlist is what keeps the network out: what remains is only what
Node's own allowed modules reach internally. For a hard boundary, run the service where it has
no outbound network, or give its user a firewall rule. On Node 25 the permission model itself
can deny the child the network.

**Packaging.** Ship this package as files, as an external dependency of any bundle: never
bundle it into one script (the `openhoard` CLI bundles the core packages, but not this one).
The child runs from its own file (`dist/child.js`) and reads its libraries from their package
folders, which the grant names one by one; bundled, the child can't be found, or the grant
would have to cover the whole bundle. On an npm install, `--omit=optional` keeps pdf.js's
optional native canvas (`@napi-rs/canvas`) off the disk; installed or not, it can never load in
the child (`--no-addons`, and its folder isn't readable).

## Libraries

Pure JavaScript, permissively licensed, pinned exactly, each more than a week old when chosen
(2026-09-26). Check the notes here again before upgrading.

| Library                             | License    | Why                                                                                                                                                                                                                                                  |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdfjs-dist` 6.3.289 (legacy build) | Apache-2.0 | Mozilla's PDF.js: the reference JS reader. Its optional native canvas (`@napi-rs/canvas`) is not installed (`ignoredOptionalDependencies`); text needs none. Runs with font loading, system fonts, WebAssembly decoders, image decoding and XFA off. |
| `yauzl` 3.4.0                       | MIT        | ZIP reader that reads the central directory, rejects bad names, and fails an entry that inflates past its declared size. Uses Node's zlib.                                                                                                           |
| `saxes` 6.0.0                       | ISC        | Streaming, non-validating XML parser: no DTD processing, no external entities, only XML's five entities. Old but stable (jsdom's).                                                                                                                   |
| `csv-parse` 7.0.2                   | MIT        | Streaming CSV parser with a record size limit.                                                                                                                                                                                                       |

## Tests

```sh
pnpm --filter @openhoard/enricher-extract test        # everything but the 1 GiB CSV
pnpm --filter @openhoard/enricher-extract test:slow   # the 1 GiB CSV (about a minute on Linux)
```

- **Golden files** (`golden/*.json`): one fixture per kind, made in the tests (no checked-in
  documents), extracted in-process and through the sandbox; the two must match the file.
  `UPDATE_GOLDEN=1` rewrites them after a deliberate change: review the diff.
- **Hostile files**: zip bombs (ratio, lying sizes, entry count, total size), encrypted
  entries, billion laughs and external entities, 100,000-deep XML, malformed XML, PDFs and
  archives, binary garbage, a CSV with no line breaks, wrong extensions, OLE containers.
- **The sandbox**: timeouts, the memory cap, aborts, failing, stalling, short and long sources
  (and the streams closed), a child that crashes, is killed by a signal, hangs, says too much or
  answers the wrong shape, an install whose links would widen the grant, and a probe that tries
  every refused built-in, binding, read and write above in a real child.
- **Grants** (`paths.test.ts`): a simulated hoisted npm layout gets only the libraries' folders;
  a pnpm-style link into the grant is followed; a link out of it is refused.
- **1 GiB CSV** (T-402's done-when): generated as it streams, never stored; the row count is
  exact and the child's peak memory stays under 256 MiB (about 130 MiB measured). Every run
  does the same at 32 MiB; CI's Linux PostgreSQL job runs the 1 GiB one.
