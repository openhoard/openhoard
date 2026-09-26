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
Transient (enrichment retries): `spawn-failed`, `input-failed` (the source failed part way, or
ran out the clock: the child waited on it and it sent nothing for half the time limit, at most
30 s; the child is killed, never given a cut-off stream as the whole file). A source should
also stop when the signal it is given aborts: a stalled one is only abandoned, not cancelled.

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

- read only its own package and its libraries' `node_modules` folders (`--allow-fs-read`, real
  paths): no configuration, data folder, blob store, home or temp files; write nothing;
- no child processes, worker threads, native addons (`--no-addons` too), WASI, inspector, or
  `process.binding()`;
- no `eval` or `new Function` (`--disallow-code-generation-from-strings`), no `__proto__`
  (`--disable-proto=delete`);
- an environment with only its settings: none of the server's variables (no database URL, no
  keys). On Windows, `SystemRoot` too, without which no process starts.

**Network, best effort.** Node 24's permission model has no network switch (`--allow-net`
comes in Node 25). The child's lockdown (`lockdown.ts`, before any parser loads) refuses to
load `net`, `tls`, `dgram`, `dns`, `http`, `https`, `http2`, `child_process`, `cluster`,
`worker_threads` and `inspector` by import, require or `process.getBuiltinModule()`, and
removes `fetch`, `WebSocket` and `EventSource`. That leaves only what Node's own modules reach
internally. For a hard boundary, run the service where it has no outbound network, or give its
user a firewall rule. On Node 25 the child can be denied the network by the permission model
itself (no `--allow-net`).

**Packaging.** The child runs from its own file (`dist/child.js`) and reads its libraries from
disk, so this package ships as files: bundling it into one script breaks the sandbox (the
child can't be found, or can read the whole bundle's folder).

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
- **The sandbox**: timeouts, the memory cap, aborts, a failing source, a child that crashes,
  hangs, says too much or answers the wrong shape, and a probe that checks the confinement
  above in a real child.
- **1 GiB CSV** (T-402's done-when): generated as it streams, never stored; the row count is
  exact and the child's peak memory stays under 256 MiB (about 130 MiB measured). Every run
  does the same at 32 MiB; CI's Linux PostgreSQL job runs the 1 GiB one.
