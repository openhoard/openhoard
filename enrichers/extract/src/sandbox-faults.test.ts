import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { extract } from "./sandbox.ts";
import { chunked } from "./test.fixtures.ts";

/*
 * A child that misbehaves (fake-child.fixtures.ts, started in place of child.ts with the same
 * options): each way must end in the right typed failure, and nothing it said is used.
 */

const install = vi.hoisted(() => ({ unsafe: false }));
vi.mock(import("./paths.ts"), async (original) => {
  const paths = await original();
  return {
    ...paths,
    childEntry: () => join(dirname(fileURLToPath(import.meta.url)), "fake-child.fixtures.ts"),
    readablePaths: () => {
      if (install.unsafe) throw new paths.UnsafeInstallError("node_modules/evil");
      return paths.readablePaths();
    },
  };
});

const run = (name: string, limits = {}) =>
  extract(chunked(new TextEncoder().encode("some text")), { mime: "text/plain", name }, { limits });

describe("a child that misbehaves", () => {
  it.each([
    ["crash.txt", "crashed"],
    ["fatal.txt", "crashed"],
    ["memory.txt", "memory-limit"],
    ["heap.txt", "memory-limit"],
    ["garbage.txt", "protocol"],
    ["two-lines.txt", "protocol"],
    ["extra-key.txt", "protocol"],
    ["dirty-text.txt", "protocol"],
    ["unknown-failure.txt", "protocol"],
    ["chatty.txt", "output-too-large"],
  ])("%s ends as %s", async (name, failure) => {
    expect(await run(name)).toEqual({ ok: false, failure, permanent: true });
  });

  it.skipIf(process.platform === "win32")(
    "is worth another try when a signal nobody sent killed it",
    async () => {
      expect(await run("sigkill.txt")).toEqual({ ok: false, failure: "killed", permanent: false });
    },
  );

  it("is worth another try when it exits 1 without an answer (terminated on Windows)", async () => {
    expect(await run("exit1.txt")).toEqual({ ok: false, failure: "killed", permanent: false });
  });

  it("never starts, and closes the content, when the install would widen the sandbox", async () => {
    install.unsafe = true;
    try {
      const { Readable } = await import("node:stream");
      const stream = Readable.from([new TextEncoder().encode("x")]);
      await expect(extract(stream, { mime: "text/plain" })).rejects.toThrow(
        "would be widened by a link",
      );
      expect(stream.destroyed).toBe(true);
    } finally {
      install.unsafe = false;
    }
  });

  it("is killed when it hangs", async () => {
    expect(await run("hang.txt", { timeoutMs: 1_000 })).toEqual({
      ok: false,
      failure: "timeout",
      permanent: true,
    });
  });

  it("passes on a typed failure with its stats, and a valid answer", async () => {
    expect(await run("failure.txt")).toEqual({
      ok: false,
      failure: "encrypted",
      permanent: true,
      stats: { bytesRead: 0, peakRssBytes: 1 },
    });
    expect(await run("fine.txt")).toMatchObject({ ok: true, extraction: { text: "hello" } });
  });
});
