import { validatePluginManifest } from "@openhoard/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  manifestCapabilities,
  type Connector,
  type ConnectorDescription,
  type ItemAcl,
  type SourceItem,
  type SyncEvent,
} from "../connector.js";
import { isAbortError, isConnectorError, type ConnectorErrorCode } from "../errors.js";
import {
  checkAcl,
  checkDescription,
  checkEvent,
  checkRedirect,
  refOf,
  storableText,
} from "../validate.js";

/*
 * The connector contract kit (T-301): one Vitest suite every connector runs against a source it
 * can change, so "meets interface v1" means the same thing for all of them.
 *
 *   import { connectorContract } from "@openhoard/sdk/testing";
 *   connectorContract("fs", { checkpointEvery: 5, open: async () => myFixture() });
 *
 * The fixture opens a fresh, empty source per test and changes it the way people would (make a
 * folder, write a file, move, delete). The kit seeds a tree, then checks: describe() and the
 * manifest; crawl completeness, parents first, consistent paths; determinism; resuming from a
 * checkpoint after the consumer stops or the signal aborts; delta (creates, updates, renames,
 * moves, deletes, applied in order, give what a fresh crawl sees); read() returning exactly the
 * crawled bytes and refusing changed ones; ACL normalization; redirect URLs; the error codes;
 * cancellation. Everything a connector yields passes the runner's own checks (validate.ts).
 */

/** Faults a fixture may be able to make its source produce on the next call. */
export type Fault = "throttled" | "unavailable" | "auth";

/** One fresh source and the connector over it, for one test. */
export interface ContractSource {
  readonly connector: Connector;
  /** Makes a folder (and the folders above it). */
  mkdir(path: readonly string[]): Promise<void>;
  /** Creates a file, or replaces its content (making the folders above it). */
  write(path: readonly string[], bytes: Uint8Array): Promise<void>;
  /** Renames or moves a file or a folder (with everything in it). */
  move(from: readonly string[], to: readonly string[]): Promise<void>;
  /** Deletes a file or a folder (with everything in it). */
  remove(path: readonly string[]): Promise<void>;
  /** What aclImport() should return for the item at `path`, when the fixture knows. */
  expectedAcl?(path: readonly string[]): Promise<ItemAcl | undefined>;
  /** Makes the next call to the source fail this way. Tests of faults run only with it. */
  fault?(kind: Fault): void;
  close(): Promise<void>;
}

export interface ContractFixture {
  open(): Promise<ContractSource>;
  /**
   * How many items the connector yields at most between checkpoints (as configured for the
   * fixture): the kit seeds a tree several times that size and expects checkpoints in it.
   */
  checkpointEvery: number;
  /** The connector's plugin manifest (openhoard.plugin.json), checked against describe(). */
  manifest?: unknown;
  /**
   * Per-test (and per-hook) timeout in milliseconds. Default 30,000. A slow platform can be
   * given more here.
   */
  timeoutMs?: number;
}

const enc = new TextEncoder();

/** Declares the contract suite for one connector. Call it at the top level of a test file. */
export function connectorContract(name: string, fixture: ContractFixture): void {
  const timeout = fixture.timeoutMs ?? 30_000;
  if (!(Number.isSafeInteger(timeout) && timeout > 0)) {
    throw new RangeError("timeoutMs");
  }
  const every = fixture.checkpointEvery;
  if (!Number.isSafeInteger(every) || every < 1) throw new RangeError("checkpointEvery");

  describe(`connector contract: ${name}`, () => {
    let source: ContractSource;
    let connector: Connector;
    let description: ConnectorDescription;
    /** What the kit wrote, by path key. */
    let files: Map<string, Uint8Array>;
    let folders: Set<string>;

    beforeEach(async () => {
      source = await fixture.open();
      connector = source.connector;
      description = connector.describe();
      files = new Map();
      folders = new Set();
    }, timeout);
    afterEach(async () => {
      await connector?.close?.();
      await source?.close();
    }, timeout);

    const write = async (path: string[], content: string | Uint8Array) => {
      const bytes = typeof content === "string" ? enc.encode(content) : content;
      await source.write(path, bytes);
      files.set(key(path), bytes);
      for (let i = 1; i < path.length; i++) folders.add(key(path.slice(0, i)));
    };
    const mkdir = async (path: string[]) => {
      await source.mkdir(path);
      for (let i = 1; i <= path.length; i++) folders.add(key(path.slice(0, i)));
    };
    /** Whether the path key `k` is `path` or below it. */
    const within = (k: string, path: string[]) => {
      const names = JSON.parse(k) as string[];
      return names.length >= path.length && key(names.slice(0, path.length)) === key(path);
    };
    const move = async (from: string[], to: string[]) => {
      await source.move(from, to);
      const rename = (k: string) =>
        within(k, from) ? key([...to, ...(JSON.parse(k) as string[]).slice(from.length)]) : k;
      files = new Map([...files].map(([k, v]) => [rename(k), v]));
      folders = new Set([...folders].map(rename));
      for (let i = 1; i < to.length; i++) folders.add(key(to.slice(0, i)));
    };
    const remove = async (path: string[]) => {
      await source.remove(path);
      for (const f of [...files.keys()]) if (within(f, path)) files.delete(f);
      for (const f of [...folders]) if (within(f, path)) folders.delete(f);
    };

    /** A tree with nesting, an empty folder, an empty file, a larger file, and many files. */
    const seed = async () => {
      await write(["Projects", "Apollo", "plan.md"], "# Plan\n\nShip it.\n");
      await write(["Projects", "Apollo", "budget.csv"], "item,amount\nfuel,100\n");
      await write(["Projects", "Apollo", "Specs", "résumé draft.txt"], "naïve café\n");
      await write(["Projects", "Zeus", "notes.txt"], "notes\n");
      await mkdir(["Empty folder"]);
      await write(["empty.txt"], new Uint8Array(0));
      await write(["big.bin"], pseudoRandom(200_000));
      for (let i = 0; i < every * 3 + 2; i++) {
        await write(["Many", `file-${String(i).padStart(3, "0")}.txt`], `file ${i}\n`);
      }
    };

    const crawl = (checkpoint: string | null = null, signal = new AbortController().signal) =>
      collect(connector.crawl(checkpoint, signal));

    /** Checks a whole run's events: valid, one `done`, last. */
    const checkRun = (events: SyncEvent[]) => {
      for (const e of events) expect(checkEvent(e, description), JSON.stringify(e)).toBeNull();
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect(events[events.length - 1]?.type).toBe("done");
    };
    const itemsOf = (events: SyncEvent[]) =>
      events.flatMap((e) => (e.type === "item" ? [e.item] : []));
    const cursorOf = (events: SyncEvent[]) => {
      const done = events[events.length - 1];
      if (done?.type !== "done") throw new Error("no done event");
      return done.cursor;
    };

    /** The source as a crawl sees it: every item once, parents first, paths consistent. */
    const checkTree = (items: SourceItem[]) => {
      const byId = new Map<string, SourceItem>();
      for (const item of items) {
        expect(byId.has(item.externalId), `${item.externalId} twice`).toBe(false);
        if (item.parentId !== null) {
          const parent = byId.get(item.parentId);
          expect(parent, `${item.path.join("/")}: parent first`).toBeDefined();
          expect(parent?.kind).toBe("folder");
          expect(key(item.path.slice(0, -1))).toBe(key(parent?.path ?? []));
        } else {
          expect(item.path).toHaveLength(1);
        }
        byId.set(item.externalId, item);
      }
      const seen = new Map(items.map((i) => [key(i.path), i]));
      expect(new Set(seen.keys())).toEqual(new Set([...files.keys(), ...folders]));
      for (const [k, bytes] of files) {
        expect(seen.get(k)?.kind, k).toBe("file");
        expect(seen.get(k)?.size, k).toBe(bytes.byteLength);
      }
      for (const k of folders) expect(seen.get(k)?.kind, k).toBe("folder");
      return byId;
    };

    it(
      "describes itself validly, as its methods and its manifest say",
      async () => {
        expect(checkDescription(description)).toEqual([]);
        expect(typeof connector.delta === "function").toBe(description.capabilities.delta);
        expect(typeof connector.aclImport === "function").toBe(description.capabilities.aclImport);
        expect(typeof connector.redirect === "function").toBe(description.capabilities.redirect);
        if (fixture.manifest !== undefined) {
          const m = fixture.manifest as { name?: unknown; type?: unknown; capabilities?: unknown };
          expect(validatePluginManifest(m).errors).toEqual([]);
          expect(m.type).toBe("connector");
          expect(m.name).toBe(description.id);
          expect(m.capabilities).toEqual(expect.arrayContaining(manifestCapabilities(description)));
        }
      },
      timeout,
    );

    it(
      "names what the source is the same way every time, when it can",
      async () => {
        if (!connector.identity) return;
        const signal = new AbortController().signal;
        const identity = await connector.identity(signal);
        expect(storableText(identity) && identity.length > 0 && identity.length <= 1024).toBe(true);
        await seed();
        expect(await connector.identity(signal)).toBe(identity);
        // Asked with what was recorded, an unchanged source answers the same.
        expect(await connector.identity(signal, identity)).toBe(identity);
      },
      timeout,
    );

    it(
      "crawls every item once, parents first, with paths that agree with parents",
      async () => {
        await seed();
        const events = await crawl();
        checkRun(events);
        checkTree(itemsOf(events));
        expect(
          events.some((e) => e.type === "checkpoint"),
          "checkpoints in a large tree",
        ).toBe(true);
        // Checkpoints come at least every `checkpointEvery` items.
        let since = 0;
        for (const e of events) {
          if (e.type === "item") since++;
          if (e.type === "checkpoint") since = 0;
          expect(since).toBeLessThanOrEqual(every);
        }
      },
      timeout,
    );

    it(
      "crawls an unchanged source the same way twice",
      async () => {
        await seed();
        const first = itemsOf(await crawl());
        const second = itemsOf(await crawl());
        expect(second).toEqual(first);
      },
      timeout,
    );

    it(
      "resumes after the last checkpoint when the consumer stops, and its cursor covers the whole crawl",
      async () => {
        await seed();
        const full = itemsOf(await crawl());
        const before: SyncEvent[] = [];
        let token: string | undefined;
        let checkpoints = 0;
        // Stop at the second checkpoint: the iterator is returned, as a runner that stops does.
        for await (const e of connector.crawl(null, new AbortController().signal)) {
          before.push(e);
          if (e.type !== "checkpoint") continue;
          token = e.token;
          if (++checkpoints === 2) break;
        }
        expect(token).toBeDefined();
        const after = await crawl(token as string);
        checkRun(after);
        const union = new Map<string, SourceItem>();
        for (const item of [...itemsOf(before), ...itemsOf(after)])
          union.set(item.externalId, item);
        expect(new Set(union.keys())).toEqual(new Set(full.map((i) => i.externalId)));
        // Items before the checkpoint aren't needed again.
        const early = new Set(itemsOf(before).map((i) => i.externalId));
        expect(itemsOf(after).some((i) => early.has(i.externalId))).toBe(false);
        if (connector.delta) {
          const next = await collect(
            connector.delta(cursorOf(after), new AbortController().signal),
          );
          checkRun(next);
          expect(next.filter((e) => e.type !== "done")).toEqual([]);
        }
      },
      timeout,
    );

    it(
      "resumes after the last checkpoint when the crawl's signal aborts",
      async () => {
        await seed();
        const full = itemsOf(await crawl());
        const controller = new AbortController();
        const seen: SyncEvent[] = [];
        let token: string | undefined;
        await expectAbort(
          (async () => {
            for await (const e of connector.crawl(null, controller.signal)) {
              seen.push(e);
              if (e.type === "checkpoint") {
                token = e.token;
                controller.abort();
              }
            }
          })(),
          controller.signal,
        );
        expect(token).toBeDefined();
        const upTo = seen.findIndex((e) => e.type === "checkpoint");
        const after = itemsOf(await crawl(token as string));
        const ids = new Set([...itemsOf(seen.slice(0, upTo)), ...after].map((i) => i.externalId));
        expect(ids).toEqual(new Set(full.map((i) => i.externalId)));
      },
      timeout,
    );

    it(
      "refuses a checkpoint it can't use with resync",
      async () => {
        await seed();
        await expectCode(crawl("not a checkpoint of this connector"), ["resync"]);
      },
      timeout,
    );

    const ifDelta = (title: string, test: () => Promise<void>) =>
      it(
        title,
        async () => {
          if (!connector.delta) return;
          await test();
        },
        timeout,
      );
    const delta = (cursor: string) =>
      collect(
        (connector.delta as NonNullable<Connector["delta"]>)(cursor, new AbortController().signal),
      );

    ifDelta("reports nothing but done when nothing changed", async () => {
      await seed();
      const first = await delta(cursorOf(await crawl()));
      checkRun(first);
      expect(first.filter((e) => e.type !== "done")).toEqual([]);
      const second = await delta(cursorOf(first));
      expect(second.filter((e) => e.type !== "done")).toEqual([]);
    });

    ifDelta(
      "reports creates, updates, renames, moves and deletes in an order that gives what a fresh crawl sees",
      async () => {
        await seed();
        const events = await crawl();
        const model = checkTree(itemsOf(events));
        const idAt = (path: string[]) =>
          [...model.values()].find((i) => key(i.path) === key(path))?.externalId;
        const renamed = idAt(["Projects", "Zeus", "notes.txt"]);
        const moved = idAt(["Projects", "Apollo", "plan.md"]);
        const folder = idAt(["Projects", "Apollo"]);
        const updated = idAt(["Many", "file-001.txt"]);
        const oldVersion = model.get(updated as string)?.contentVersion;

        await write(["Projects", "Hermes", "new.txt"], "created\n");
        await write(["Many", "file-001.txt"], "updated, and longer than before\n");
        await move(["Projects", "Zeus", "notes.txt"], ["Projects", "Zeus", "Notes (final).txt"]);
        await move(["Projects", "Apollo", "plan.md"], ["Projects", "Zeus", "plan.md"]);
        await move(["Projects", "Apollo"], ["Projects", "Apollo 11"]);
        await remove(["Many", "file-002.txt"]);
        await remove(["Empty folder"]);
        await write(["gone soon.txt"], "created, then deleted\n");
        await remove(["gone soon.txt"]);

        const changes = await delta(cursorOf(events));
        checkRun(changes);
        for (const e of changes) {
          if (e.type === "deleted") {
            model.delete(e.externalId);
          } else if (e.type === "item") {
            if (e.item.parentId !== null) {
              expect(
                model.get(e.item.parentId)?.kind,
                `${e.item.path.join("/")}: parent first`,
              ).toBe("folder");
            }
            model.set(e.item.externalId, e.item);
          }
        }
        const fresh = checkTree(itemsOf(await crawl()));
        expect(sortById([...model.values()])).toEqual(sortById([...fresh.values()]));

        const now = (path: string[]) => [...fresh.values()].find((i) => key(i.path) === key(path));
        expect(now(["Many", "file-001.txt"])?.contentVersion).not.toBe(oldVersion);
        if (description.stableIds) {
          expect(now(["Projects", "Zeus", "Notes (final).txt"])?.externalId).toBe(renamed);
          expect(now(["Projects", "Zeus", "plan.md"])?.externalId).toBe(moved);
          expect(now(["Projects", "Apollo 11"])?.externalId).toBe(folder);
          expect(now(["Many", "file-001.txt"])?.externalId).toBe(updated);
        }
      },
    );

    ifDelta("reports a change to an item the crawl had already yielded", async () => {
      await seed();
      const events: SyncEvent[] = [];
      let changed = false;
      for await (const e of connector.crawl(null, new AbortController().signal)) {
        events.push(e);
        if (!changed && e.type === "item" && key(e.item.path) === key(["Many", "file-000.txt"])) {
          await write(["Many", "file-000.txt"], "changed while the crawl ran\n");
          changed = true;
        }
      }
      expect(changed).toBe(true);
      const changes = await delta(cursorOf(events));
      const item = itemsOf(changes).find((i) => key(i.path) === key(["Many", "file-000.txt"]));
      expect(item?.size).toBe(enc.encode("changed while the crawl ran\n").byteLength);
    });

    ifDelta("refuses a cursor it can't use with resync", async () => {
      await seed();
      await expectCode(delta("not a cursor of this connector"), ["resync"]);
    });

    it(
      "reads exactly the crawled bytes of every file",
      async () => {
        await seed();
        const items = itemsOf(await crawl());
        for (const item of items.filter((i) => i.kind === "file")) {
          const result = await connector.read(refOf(item), new AbortController().signal);
          expect(result.contentVersion).toBe(item.contentVersion);
          expect(result.size).toBe(item.size);
          const bytes = await drain(result.body);
          expect(
            Buffer.from(bytes).equals(Buffer.from(files.get(key(item.path)) as Uint8Array)),
            item.path.join("/"),
          ).toBe(true);
        }
      },
      timeout,
    );

    it(
      "refuses to read a file that changed or went since the crawl, and anything that isn't one",
      async () => {
        await seed();
        const items = itemsOf(await crawl());
        const at = (path: string[]) => items.find((i) => key(i.path) === key(path)) as SourceItem;
        const signal = new AbortController().signal;

        const changed = at(["Projects", "Apollo", "budget.csv"]);
        await write(["Projects", "Apollo", "budget.csv"], "item,amount\nfuel,250\noxygen,75\n");
        await expectCode(connector.read(refOf(changed), signal), ["changed"]);
        // The version a new crawl reports reads the new bytes.
        const fresh = itemsOf(await crawl()).find(
          (i) => i.externalId === changed.externalId || key(i.path) === key(changed.path),
        ) as SourceItem;
        const now = await drain((await connector.read(refOf(fresh), signal)).body);
        expect(new TextDecoder().decode(now)).toBe("item,amount\nfuel,250\noxygen,75\n");

        const gone = at(["Projects", "Zeus", "notes.txt"]);
        await remove(["Projects", "Zeus", "notes.txt"]);
        await expectCode(connector.read(refOf(gone), signal), ["not-found", "changed"]);

        await expectCode(
          connector.read({ externalId: "no-such-item", contentVersion: "1" }, signal),
          ["not-found"],
        );
        const folder = at(["Projects"]);
        await expectCode(connector.read({ ...refOf(folder), contentVersion: "1" }, signal), [
          "permanent",
          "not-found",
        ]);
        const { contentVersion: _v, ...unversioned } = refOf(at(["empty.txt"]));
        await expectCode(connector.read(unversioned, signal), ["permanent"]);
      },
      timeout,
    );

    it(
      "imports normalized permissions for every item",
      async () => {
        if (!connector.aclImport) return;
        await seed();
        const signal = new AbortController().signal;
        for (const item of itemsOf(await crawl())) {
          const acl = await connector.aclImport(refOf(item), signal);
          expect(checkAcl(acl), item.path.join("/")).toBeNull();
          const expected = await source.expectedAcl?.(item.path);
          if (expected) expect(acl).toEqual(expected);
        }
        await expectCode(connector.aclImport({ externalId: "no-such-item" }, signal), [
          "not-found",
        ]);
      },
      timeout,
    );

    it(
      "redirects every item to a well-formed URL of a declared scheme, the same every time",
      async () => {
        if (!connector.redirect) return;
        await seed();
        const signal = new AbortController().signal;
        const urls = new Set<string>();
        for (const item of itemsOf(await crawl())) {
          const url = await connector.redirect(refOf(item), signal);
          expect(checkRedirect(url, description), url).toBeNull();
          expect(await connector.redirect(refOf(item), signal)).toBe(url);
          urls.add(url);
        }
        expect(urls.size, "one URL per item").toBe(itemsOf(await crawl()).length);
        await expectCode(connector.redirect({ externalId: "no-such-item" }, signal), ["not-found"]);
      },
      timeout,
    );

    it(
      "reports faults of the source with their codes",
      async () => {
        if (!source.fault) return;
        await seed();
        source.fault("throttled");
        const throttled = await expectCode(crawl(), ["throttled"]);
        expect(throttled.retryAfterMs).toBeGreaterThanOrEqual(0);
        expect(throttled.retryable).toBe(true);
        source.fault("unavailable");
        expect((await expectCode(crawl(), ["retryable"])).retryable).toBe(true);
        source.fault("auth");
        expect((await expectCode(crawl(), ["auth"])).retryable).toBe(false);
        // And works again afterwards.
        checkRun(await crawl());
      },
      timeout,
    );

    it(
      "stops a crawl, a delta and a read when their signal aborts",
      async () => {
        await seed();
        const before = new AbortController();
        before.abort();
        await expectAbort(crawl(null, before.signal), before.signal);

        const midway = new AbortController();
        const events: SyncEvent[] = [];
        await expectAbort(
          (async () => {
            for await (const e of connector.crawl(null, midway.signal)) {
              events.push(e);
              if (events.length === 2) midway.abort();
            }
          })(),
          midway.signal,
        );
        expect(events.length).toBeLessThan(every * 3);

        const items = itemsOf(await crawl());
        if (connector.delta) {
          const d = new AbortController();
          d.abort();
          await expectAbort(collect(connector.delta(cursorOf(await crawl()), d.signal)), d.signal);
        }
        const big = items.find((i) => key(i.path) === key(["big.bin"])) as SourceItem;
        const r1 = new AbortController();
        r1.abort();
        await expectAbort(connector.read(refOf(big), r1.signal), r1.signal);
        const r2 = new AbortController();
        const result = await connector.read(refOf(big), r2.signal);
        await expectAbort(
          (async () => {
            for await (const chunk of result.body) {
              void chunk;
              r2.abort();
            }
          })(),
          r2.signal,
        );
      },
      timeout,
    );
  });
}

/** A path as a map key: its names in NFC, so a file system that decomposes them agrees. */
function key(path: readonly string[]): string {
  return JSON.stringify(path.map((n) => n.normalize("NFC")));
}

function sortById(items: SourceItem[]): SourceItem[] {
  return [...items].sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
}

async function collect(events: AsyncIterable<SyncEvent>): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

async function expectCode(
  work: Promise<unknown>,
  codes: ConnectorErrorCode[],
): Promise<{ code: ConnectorErrorCode; retryAfterMs: number | undefined; retryable: boolean }> {
  let error: unknown;
  try {
    await work;
  } catch (e) {
    error = e;
  }
  expect(error, `expected a ConnectorError ${codes.join(" or ")}`).toBeDefined();
  expect(isConnectorError(error), `not a ConnectorError: ${String(error)}`).toBe(true);
  const e = error as {
    code: ConnectorErrorCode;
    retryAfterMs: number | undefined;
    retryable: boolean;
  };
  expect(codes).toContain(e.code);
  return e;
}

async function expectAbort(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  let error: unknown;
  try {
    await work;
  } catch (e) {
    error = e;
  }
  expect(error, "expected the work to stop with the signal's reason").toBeDefined();
  expect(isAbortError(error, signal), `not a cancellation: ${String(error)}`).toBe(true);
}

/** Deterministic bytes that don't compress. */
function pseudoRandom(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
