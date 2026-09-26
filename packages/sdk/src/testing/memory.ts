import { createHash } from "node:crypto";
import {
  CONNECTOR_API_VERSION,
  type AclEntry,
  type Connector,
  type ConnectorDescription,
  type ItemAcl,
  type ItemRef,
  type SourceItem,
  type SyncEvent,
} from "../connector.js";
import {
  authError,
  changedError,
  notFoundError,
  permanentError,
  resyncError,
  retryableError,
  throttledError,
  type ConnectorError,
} from "../errors.js";
import { normalizeAcl } from "../validate.js";
import type { ContractSource, Fault } from "./contract.js";

/*
 * A reference connector over an in-memory tree: the smallest thing that meets the contract, for
 * connector authors to read next to the kit, and for the core's tests to drive the sync runner
 * with faults a real source can't be made to produce on demand (throttling mid-crawl).
 *
 * It behaves like a delta API (Microsoft Graph's): a crawl reads a copy of the tree taken when it
 * starts, its cursor is that copy, and a delta compares the tree now with the copy its cursor
 * names. Tokens name copies it keeps in memory: after close(), or for a copy it never made, they
 * are refused with `resync`.
 */

export interface MemorySourceOptions {
  /** A `checkpoint` after every this many items. Default 3. */
  checkpointEvery?: number;
  /** Keep ids across renames and moves (true, default), or key items by path. */
  stableIds?: boolean;
  /** Size of the chunks read() returns. Default 7 bytes, so every read takes several. */
  chunkSize?: number;
}

interface Node {
  id: string;
  kind: "file" | "folder";
  name: string;
  parent: Node | null;
  children: Map<string, Node>;
  bytes: Uint8Array;
  /** Bumped on every write: the file's contentVersion. */
  content: number;
  acl: AclEntry[];
}

/** An in-memory source and the connector over it. */
export class MemorySource implements ContractSource {
  readonly connector: Connector;
  /** How often each method was called: crawl, delta, read, aclImport, redirect. */
  readonly calls = { crawl: 0, delta: 0, read: 0, aclImport: 0, redirect: 0 };
  private readonly root: Node = node("root", "folder", "", null);
  private readonly byId = new Map<string, Node>();
  private readonly copies = new Map<number, SourceItem[]>();
  private generation = 0;
  private nextId = 1;
  private readonly pending: { kind: Fault; afterEvents: number }[] = [];
  private readonly every: number;
  private readonly stableIds: boolean;
  private readonly chunk: number;
  /** What identity() answers: a new source gets a new one, and a test may change it. */
  identity = `memory:${++sources}`;

  constructor(options: MemorySourceOptions = {}) {
    this.every = options.checkpointEvery ?? 3;
    this.stableIds = options.stableIds ?? true;
    this.chunk = options.chunkSize ?? 7;
    const description: ConnectorDescription = {
      apiVersion: CONNECTOR_API_VERSION,
      id: "memory",
      version: "1.0.0",
      zoneKinds: ["indexed", "managed"],
      capabilities: { delta: true, aclImport: true, redirect: true },
      stableIds: this.stableIds,
    };
    // Arrow functions over `this`, so a runner may pass the methods around unbound.
    this.connector = {
      describe: () => ({ ...description, capabilities: { ...description.capabilities } }),
      crawl: (checkpoint, signal) => this.crawl(checkpoint, signal),
      delta: (cursor, signal) => this.delta(cursor, signal),
      read: (ref, signal) => this.read(ref, signal),
      aclImport: (ref, signal) => this.aclImport(ref, signal),
      redirect: (ref, signal) => this.redirect(ref, signal),
      identity: async (signal) => {
        signal.throwIfAborted();
        return this.identity;
      },
      close: async () => this.copies.clear(),
    };
  }

  async mkdir(path: readonly string[]): Promise<void> {
    this.ensureFolder(path);
  }

  async write(path: readonly string[], bytes: Uint8Array): Promise<void> {
    const parent = this.ensureFolder(path.slice(0, -1));
    const name = last(path);
    let file = parent.children.get(name);
    if (file?.kind === "folder") throw new Error(`${path.join("/")} is a folder`);
    if (!file) {
      file = node(this.newId(), "file", name, parent);
      parent.children.set(name, file);
      this.byId.set(file.id, file);
    }
    file.bytes = bytes.slice();
    file.content++;
  }

  async move(from: readonly string[], to: readonly string[]): Promise<void> {
    const n = this.find(from);
    if (!n) throw new Error(`no ${from.join("/")}`);
    const parent = this.ensureFolder(to.slice(0, -1));
    if (parent.children.has(last(to))) throw new Error(`${to.join("/")} exists`);
    n.parent?.children.delete(n.name);
    n.name = last(to);
    n.parent = parent;
    parent.children.set(n.name, n);
  }

  async remove(path: readonly string[]): Promise<void> {
    const n = this.find(path);
    if (!n) throw new Error(`no ${path.join("/")}`);
    n.parent?.children.delete(n.name);
    const drop = (x: Node) => {
      this.byId.delete(x.id);
      for (const c of x.children.values()) drop(c);
    };
    drop(n);
  }

  /** Sets the permissions the source reports for an item. */
  setAcl(path: readonly string[], entries: readonly AclEntry[]): void {
    const n = this.find(path);
    if (!n) throw new Error(`no ${path.join("/")}`);
    n.acl = normalizeAcl(entries);
  }

  async expectedAcl(path: readonly string[]): Promise<ItemAcl | undefined> {
    const n = this.find(path);
    return n ? { basis: "source", entries: n.acl } : undefined;
  }

  /**
   * The next call (crawl, delta, read, aclImport or redirect) fails with this fault; a crawl or
   * delta after yielding `afterEvents` events (default 0: before the first).
   */
  fault(kind: Fault, options: { afterEvents?: number } = {}): void {
    this.pending.push({ kind, afterEvents: options.afterEvents ?? 0 });
  }

  async close(): Promise<void> {
    this.copies.clear();
  }

  // ── the connector ───────────────────────────────────────────────────────────────────────

  private async *crawl(checkpoint: string | null, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    this.calls.crawl++;
    signal.throwIfAborted();
    const fault = this.pending.shift();
    let generation: number;
    let start = 0;
    if (checkpoint === null) {
      generation = ++this.generation;
      this.copies.set(generation, this.freeze());
    } else {
      const m = /^crawl:(\d{1,9}):(\d{1,9})$/.exec(checkpoint);
      generation = Number(m?.[1]);
      start = Number(m?.[2]);
      if (!m || !this.copies.has(generation)) throw resyncError();
    }
    const items = this.copies.get(generation) as SourceItem[];
    const events: SyncEvent[] = [];
    for (let i = start; i < items.length; i++) {
      events.push({ type: "item", item: items[i] as SourceItem });
      if ((i + 1) % this.every === 0 && i + 1 < items.length) {
        events.push({ type: "checkpoint", token: `crawl:${generation}:${i + 1}` });
      }
    }
    events.push({ type: "done", cursor: `delta:${generation}` });
    yield* emit(events, signal, fault);
  }

  private async *delta(cursor: string, signal: AbortSignal): AsyncGenerator<SyncEvent> {
    this.calls.delta++;
    signal.throwIfAborted();
    const fault = this.pending.shift();
    const m = /^delta:(\d{1,9})$/.exec(cursor);
    const before = m ? this.copies.get(Number(m[1])) : undefined;
    if (!before) throw resyncError();
    const generation = ++this.generation;
    const now = this.freeze();
    this.copies.set(generation, now);
    const events: SyncEvent[] = [];
    const current = new Map(now.map((i) => [i.externalId, i]));
    // Deletes first, deepest first, then what is new or changed, parents first.
    for (const old of [...before].reverse()) {
      if (!current.has(old.externalId))
        events.push({ type: "deleted", externalId: old.externalId });
    }
    const was = new Map(before.map((i) => [i.externalId, i.etag]));
    for (const item of now) {
      if (was.get(item.externalId) !== item.etag) events.push({ type: "item", item });
    }
    events.push({ type: "done", cursor: `delta:${generation}` });
    yield* emit(events, signal, fault);
  }

  private async read(ref: ItemRef, signal: AbortSignal) {
    this.calls.read++;
    signal.throwIfAborted();
    this.failIfFaulted();
    const n = this.byId.get(ref.externalId) ?? this.byPath(ref.externalId);
    if (!n) throw notFoundError();
    if (n.kind !== "file") throw permanentError("a folder has no content");
    if (ref.contentVersion === undefined) throw permanentError("read() needs a contentVersion");
    if (ref.contentVersion !== contentVersionOf(n)) throw changedError();
    const bytes = n.bytes;
    const chunk = this.chunk;
    const version = ref.contentVersion;
    return {
      contentVersion: version,
      size: bytes.byteLength,
      contentId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      body: (async function* () {
        for (let at = 0; at < bytes.byteLength; at += chunk) {
          await tick(signal);
          yield bytes.slice(at, at + chunk);
        }
        // Changed while it was read: the bytes may be a mix of two versions.
        if (contentVersionOf(n) !== version) throw changedError();
      })(),
    };
  }

  private async aclImport(ref: ItemRef, signal: AbortSignal): Promise<ItemAcl> {
    this.calls.aclImport++;
    signal.throwIfAborted();
    this.failIfFaulted();
    const n = this.byId.get(ref.externalId) ?? this.byPath(ref.externalId);
    if (!n) throw notFoundError();
    return { basis: "source", entries: n.acl };
  }

  private async redirect(ref: ItemRef, signal: AbortSignal): Promise<string> {
    this.calls.redirect++;
    signal.throwIfAborted();
    this.failIfFaulted();
    const n = this.byId.get(ref.externalId) ?? this.byPath(ref.externalId);
    if (!n) throw notFoundError();
    return `https://memory.example/items/${encodeURIComponent(this.idOf(n))}`;
  }

  // ── the tree ────────────────────────────────────────────────────────────────────────────

  private failIfFaulted() {
    const fault = this.pending.shift();
    if (fault) throw faultError(fault.kind);
  }

  private newId(): string {
    return `m${this.nextId++}`;
  }

  private idOf(n: Node): string {
    return this.stableIds ? n.id : `p:${JSON.stringify(pathOf(n))}`;
  }

  private byPath(externalId: string): Node | undefined {
    if (this.stableIds || !externalId.startsWith("p:")) return undefined;
    try {
      const path = JSON.parse(externalId.slice(2)) as unknown;
      return Array.isArray(path) ? this.find(path as string[]) : undefined;
    } catch {
      return undefined;
    }
  }

  private find(path: readonly string[]): Node | undefined {
    let n: Node | undefined = this.root;
    for (const name of path) n = n?.children.get(name);
    return n === this.root ? undefined : n;
  }

  private ensureFolder(path: readonly string[]): Node {
    let n = this.root;
    for (const name of path) {
      let next = n.children.get(name);
      if (!next) {
        next = node(this.newId(), "folder", name, n);
        n.children.set(name, next);
        this.byId.set(next.id, next);
      }
      if (next.kind !== "folder") throw new Error(`${name} is a file`);
      n = next;
    }
    return n;
  }

  /** The tree now, parents first, names in code-unit order. */
  private freeze(): SourceItem[] {
    const items: SourceItem[] = [];
    const walk = (parent: Node) => {
      for (const name of [...parent.children.keys()].sort()) {
        const n = parent.children.get(name) as Node;
        const path = pathOf(n);
        const id = this.idOf(n);
        const base = {
          externalId: id,
          kind: n.kind,
          parentId: parent === this.root ? null : this.idOf(parent),
          path,
          url: `https://memory.example/items/${encodeURIComponent(id)}`,
        };
        if (n.kind === "file") {
          const contentVersion = contentVersionOf(n);
          items.push({
            ...base,
            mediaType: name.endsWith(".txt") ? "text/plain" : "application/octet-stream",
            size: n.bytes.byteLength,
            contentVersion,
            etag: etagOf({ path, contentVersion }),
          });
        } else {
          items.push({ ...base, etag: etagOf({ path }) });
          walk(n);
        }
      }
    };
    walk(this.root);
    return items;
  }
}

/** Numbers each source, for its identity. */
let sources = 0;

/** A fresh, empty in-memory source. */
export function memorySource(options: MemorySourceOptions = {}): MemorySource {
  return new MemorySource(options);
}

function node(id: string, kind: Node["kind"], name: string, parent: Node | null): Node {
  return {
    id,
    kind,
    name,
    parent,
    children: new Map(),
    bytes: new Uint8Array(),
    content: 0,
    acl: [],
  };
}

function pathOf(n: Node): string[] {
  const path: string[] = [];
  for (let x: Node | null = n; x && x.parent; x = x.parent) path.unshift(x.name);
  return path;
}

const contentVersionOf = (n: Node) => `${n.id}.v${n.content}`;

function etagOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function last(path: readonly string[]): string {
  const name = path[path.length - 1];
  if (name === undefined) throw new Error("a path needs a name");
  return name;
}

function faultError(kind: Fault): ConnectorError {
  switch (kind) {
    case "throttled":
      return throttledError(1_500);
    case "unavailable":
      return retryableError("the source is unavailable");
    case "auth":
      return authError("the source refused the credentials");
  }
}

/** Yields `events` one by one, failing with `fault` after `fault.afterEvents` of them. */
async function* emit(
  events: readonly SyncEvent[],
  signal: AbortSignal,
  fault: { kind: Fault; afterEvents: number } | undefined,
): AsyncGenerator<SyncEvent> {
  let yielded = 0;
  for (const e of events) {
    await tick(signal);
    if (fault && yielded === fault.afterEvents) throw faultError(fault.kind);
    yield e;
    yielded++;
  }
}

/** Yields to the event loop, and throws when the signal aborted meanwhile. */
async function tick(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
}
