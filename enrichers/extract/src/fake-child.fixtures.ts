/*
 * A child that misbehaves on purpose, for sandbox-faults.test.ts: the file name in its settings
 * says how. The parent must turn each into the right typed failure.
 */

const settings = JSON.parse(process.env.OPENHOARD_EXTRACT ?? "{}") as { hint?: { name?: string } };
const how = settings.hint?.name ?? "";
const stats = { bytesRead: 0, peakRssBytes: 1 };
const extraction = {
  kind: "text",
  text: "hello",
  truncated: false,
  metadata: {},
  signals: [],
  warnings: [],
};
const say = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0));

switch (how) {
  case "crash.txt":
    process.exit(3);
    break;
  case "memory.txt":
    process.exit(70);
    break;
  case "heap.txt":
    process.stderr.write(
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
    );
    process.exit(134);
    break;
  case "garbage.txt":
    process.stdout.write("not json\n", () => process.exit(0));
    break;
  case "two-lines.txt":
    process.stdout.write(`${JSON.stringify({ v: 1, ok: true, extraction, stats })}\n{}\n`, () =>
      process.exit(0),
    );
    break;
  case "extra-key.txt":
    say({ v: 1, ok: true, extraction: { ...extraction, secret: "x" }, stats });
    break;
  case "dirty-text.txt":
    say({
      v: 1,
      ok: true,
      extraction: { ...extraction, text: `a${String.fromCodePoint(0x202e)}b` },
      stats,
    });
    break;
  case "chatty.txt":
    process.stdout.write("x".repeat(64 * 1024 * 1024));
    break;
  case "failure.txt":
    say({ v: 1, ok: false, failure: "encrypted", stats });
    break;
  case "unknown-failure.txt":
    say({ v: 1, ok: false, failure: "spawn-failed", stats });
    break;
  case "hang.txt":
    setInterval(() => {}, 1000);
    break;
  case "sigkill.txt":
    // What the host's out-of-memory killer does.
    process.kill(process.pid, "SIGKILL");
    break;
  default:
    say({ v: 1, ok: true, extraction, stats });
}
