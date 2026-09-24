import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { contentHasher, scopedBlobId } from "@openhoard/core-catalog";
import { Operator } from "opendal";

/*
 * Content-addressed blob storage (T-203, ADR-0006 and ADR-0013).
 *
 * A blob is stored under its tenant-scoped id, `b3t:<hex>` = keyed BLAKE3 of the content's
 * BLAKE3 hash with the tenant's secret key. Identical bytes in one tenant are one blob;
 * identical bytes in two tenants are two blobs with unrelated ids, so neither storage paths
 * nor de-duplication reveal that another tenant holds the same file.
 *
 * Layout: `<tenant>/<hex[0:2]>/<hex[2:4]>/<hex>`, plus `<tenant>/.incoming/<uuid>` for
 * uploads in progress, whose id is only known once the last byte has been hashed.
 */

/** Where blobs live. Credentials may also come from the environment, as each service allows. */
export type StorageConfig =
  | { kind: "fs"; root: string }
  | { kind: "memory" }
  | {
      kind: "s3";
      bucket: string;
      region?: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      root?: string;
    }
  | {
      kind: "azblob";
      container: string;
      accountName?: string;
      accountKey?: string;
      endpoint?: string;
      root?: string;
    };

/** A tenant as storage needs it: its id (a path segment) and its 32-byte blob key. */
export interface TenantBlobKey {
  id: string;
  key: Uint8Array;
}

export interface PutResult {
  blobId: string;
  size: number;
  /** False when the tenant already had these bytes (nothing new was stored). */
  created: boolean;
}

export interface PutOptions {
  /** Refuse content longer than this many bytes. */
  maxBytes?: number;
}

export interface Range {
  /** First byte, from 0. */
  offset: number;
  /** Number of bytes; to the end when omitted. */
  length?: number;
}

export class BlobNotFoundError extends Error {
  constructor(readonly blobId: string) {
    super(`blob not found: ${blobId}`);
    this.name = "BlobNotFoundError";
  }
}

export class BlobTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`content is larger than ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

/** Builds the OpenDAL operator for a configuration. */
export function operatorFor(config: StorageConfig): Operator {
  const defined = (o: Record<string, string | undefined>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >;
  switch (config.kind) {
    case "fs":
      return new Operator("fs", { root: config.root });
    case "memory":
      return new Operator("memory", {});
    case "s3":
      return new Operator(
        "s3",
        defined({
          bucket: config.bucket,
          region: config.region,
          endpoint: config.endpoint,
          access_key_id: config.accessKeyId,
          secret_access_key: config.secretAccessKey,
          root: config.root,
        }),
      );
    case "azblob":
      return new Operator(
        "azblob",
        defined({
          container: config.container,
          account_name: config.accountName,
          account_key: config.accountKey,
          endpoint: config.endpoint,
          root: config.root,
        }),
      );
  }
}

const TENANT_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Bytes per read when streaming a range. */
const RANGE_CHUNK = 4 * 1024 * 1024;
const BLOB_ID = /^b3t:([0-9a-f]{64})$/;

export class BlobStore {
  constructor(private readonly op: Operator) {}

  static open(config: StorageConfig): BlobStore {
    return new BlobStore(operatorFor(config));
  }

  /**
   * Stores `content` for `tenant` and returns its blob id. Bytes are hashed as they stream in,
   * so memory use stays flat for any size. Storing bytes the tenant already has is a no-op
   * that returns the existing id.
   *
   * Nothing is ever written in place at a final path: content goes to `.incoming/` first and
   * moves only once complete, so a blob id never names partial bytes. An existing blob whose
   * size does not match (left by a failed move on a service without atomic moves) is replaced.
   */
  async put(
    tenant: TenantBlobKey,
    content: Uint8Array | AsyncIterable<Uint8Array>,
    options: PutOptions = {},
  ): Promise<PutResult> {
    tenantSegment(tenant.id);
    if (tenant.key.byteLength !== 32) throw new RangeError("tenant key must be 32 bytes");
    const { maxBytes } = options;
    if (content instanceof Uint8Array && maxBytes !== undefined && content.byteLength > maxBytes) {
      throw new BlobTooLargeError(maxBytes);
    }
    const source = content instanceof Uint8Array ? [content] : content;

    const incoming = `${tenant.id}/.incoming/${randomUUID()}`;
    const hasher = contentHasher();
    let size = 0;
    try {
      const writer = await this.op.writer(incoming);
      let complete = false;
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError("content chunks must be bytes");
          size += chunk.byteLength;
          if (maxBytes !== undefined && size > maxBytes) throw new BlobTooLargeError(maxBytes);
          hasher.update(chunk);
          await writer.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        complete = true;
      } finally {
        // OpenDAL writers have no abort: close either way. After a failure the partial file is
        // deleted below, and a close error must not hide the failure that caused it.
        if (complete) await writer.close();
        else await writer.close().catch(() => {});
      }
      const blobId = scopedBlobId(tenant.key, hasher.digest());
      const final = blobPath(tenant.id, blobId);
      if ((await this.sizeAt(final)) === size) {
        await this.op.delete(incoming);
        return { blobId, size, created: false };
      }
      await this.move(incoming, final, size);
      return { blobId, size, created: true };
    } catch (e) {
      await this.op.delete(incoming).catch(() => {});
      throw e;
    }
  }

  /**
   * Deletes uploads in `.incoming/` older than `olderThanMs` (default one day): what a process
   * that crashed mid-upload leaves behind. Returns how many it removed.
   */
  async sweepIncoming(tenantId: string, olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
    const dir = `${tenantSegment(tenantId)}/.incoming/`;
    let entries;
    try {
      entries = await this.op.list(dir);
    } catch (e) {
      if (isNotFound(e)) return 0;
      throw e;
    }
    let removed = 0;
    for (const entry of entries) {
      const path = entry.path();
      if (path === dir || path.endsWith("/")) continue;
      const modified = (await this.op.stat(path)).lastModified;
      // Without a timestamp the age is unknown; keep it rather than risk a live upload.
      if (modified === null || Date.now() - Date.parse(modified) < olderThanMs) continue;
      await this.op.delete(path);
      removed++;
    }
    return removed;
  }

  /** Streams a blob, or one range of it. */
  async open(tenantId: string, blobId: string, range?: Range): Promise<Readable> {
    const path = blobPath(tenantId, blobId);
    const size = await this.size(tenantId, blobId);
    if (size === undefined) throw new BlobNotFoundError(blobId);
    if (!range) return (await this.op.reader(path)).createReadStream();
    const { start, end } = checkRange(range, size);
    // OpenDAL's stream has no range option, so a range is read in bounded chunks.
    const op = this.op;
    async function* chunks() {
      for (let at = start; at <= end; at += RANGE_CHUNK) {
        const n = Math.min(RANGE_CHUNK, end - at + 1);
        yield new Uint8Array(await op.read(path, { offset: BigInt(at), size: BigInt(n) }));
      }
    }
    return Readable.from(chunks());
  }

  /** Reads a whole blob into memory. For small blobs; use {@link open} for large ones. */
  async read(tenantId: string, blobId: string, range?: Range): Promise<Uint8Array> {
    const path = blobPath(tenantId, blobId);
    const size = await this.size(tenantId, blobId);
    if (size === undefined) throw new BlobNotFoundError(blobId);
    if (!range) return new Uint8Array(await this.op.read(path));
    const { start, end } = checkRange(range, size);
    if (end < start) return new Uint8Array();
    const bytes = await this.op.read(path, {
      offset: BigInt(start),
      size: BigInt(end - start + 1),
    });
    return new Uint8Array(bytes);
  }

  /** The blob's size in bytes, or undefined when the tenant has no such blob. */
  async size(tenantId: string, blobId: string): Promise<number | undefined> {
    const size = await this.sizeAt(blobPath(tenantId, blobId));
    if (size === null) throw new Error("the storage service did not report the blob's size");
    return size;
  }

  /** Size at a path: undefined when absent, null when the service does not say. */
  private async sizeAt(path: string): Promise<number | null | undefined> {
    try {
      const { contentLength } = await this.op.stat(path);
      return contentLength === null ? null : Number(contentLength);
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async has(tenantId: string, blobId: string): Promise<boolean> {
    return this.op.exists(blobPath(tenantId, blobId));
  }

  /** Removes a blob. Removing one that is not there is not an error. */
  async delete(tenantId: string, blobId: string): Promise<void> {
    await this.op.delete(blobPath(tenantId, blobId));
  }

  /**
   * Re-reads a blob and checks its bytes still hash to its id: false means it was damaged or
   * replaced in storage.
   */
  async verify(tenant: TenantBlobKey, blobId: string): Promise<boolean> {
    const hasher = contentHasher();
    const stream = await this.open(tenant.id, blobId);
    for await (const chunk of stream as AsyncIterable<Uint8Array>) hasher.update(chunk);
    return scopedBlobId(tenant.key, hasher.digest()) === blobId;
  }

  /**
   * Moves a finished upload to its final path with the cheapest safe operation the service has.
   * Rename is atomic. A copy is checked before the upload is deleted (an Azure copy can still be
   * pending). The streamed fallback is not atomic, so on failure it removes what it wrote.
   */
  private async move(from: string, to: string, size: number): Promise<void> {
    const capability = this.op.capability();
    if (capability.rename) return this.op.rename(from, to);
    if (capability.copy) {
      await this.op.copy(from, to);
      if ((await this.sizeAt(to)) !== size) throw new Error("copy did not complete");
      return this.op.delete(from);
    }
    try {
      const reader = await this.op.reader(from);
      const writer = await this.op.writer(to);
      let complete = false;
      try {
        for await (const chunk of reader.createReadStream() as AsyncIterable<Buffer>) {
          await writer.write(chunk);
        }
        complete = true;
      } finally {
        if (complete) await writer.close();
        else await writer.close().catch(() => {});
      }
    } catch (e) {
      await this.op.delete(to).catch(() => {});
      throw e;
    }
    await this.op.delete(from);
  }
}

/** The storage path of a blob. Throws on anything that is not a tenant segment and a b3t: id. */
export function blobPath(tenantId: string, blobId: string): string {
  const hex = BLOB_ID.exec(blobId)?.[1];
  if (!hex) throw new TypeError("expected a b3t: blob id");
  return `${tenantSegment(tenantId)}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

function tenantSegment(tenantId: string): string {
  if (!TENANT_SEGMENT.test(tenantId)) throw new TypeError("invalid tenant id for storage");
  return tenantId;
}

/** Inclusive byte positions for a range, clamped to the blob. */
function checkRange(range: Range, size: number): { start: number; end: number } {
  const { offset, length } = range;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("invalid range offset");
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
    throw new RangeError("invalid range length");
  }
  const end = Math.min(size, length === undefined ? size : offset + length) - 1;
  return { start: offset, end };
}

// OpenDAL's Node errors carry the kind at the start of the message ("NotFound (permanent) …").
const isNotFound = (e: unknown) => e instanceof Error && e.message.startsWith("NotFound");
