import type { Readable } from "node:stream";
import yauzl from "yauzl";
import { ExtractError } from "./errors.ts";
import type { ExtractLimits } from "./types.ts";

/*
 * Office files are ZIP archives of XML parts, and a ZIP is where a hostile file hides its
 * size. The defences, all before or while inflating:
 *
 * - the central directory is read first, and more than `maxEntries` entries fail the file;
 * - an encrypted entry fails the file (`encrypted`); only stored and deflated entries are read;
 * - only the parts an extractor asks for are inflated, never an archive inside the archive
 *   (embedded files are counted, not opened), so nesting goes nowhere;
 * - before a part is inflated, its declared size must fit what is left of
 *   `maxUncompressedBytes`, and a part over 1 MiB may not claim more than
 *   `maxCompressionRatio` times its compressed size (a zip bomb's signature);
 * - while it inflates, yauzl checks the bytes against the declared size and fails the stream
 *   past it (`validateEntrySizes`), so a part can't lie small and inflate large; the bytes
 *   read are also counted against `maxUncompressedBytes`.
 */

const MiB = 1024 * 1024;

export class Archive {
  private used = 0;
  private readonly zip: yauzl.ZipFile;
  private readonly entries: ReadonlyMap<string, yauzl.Entry>;
  private readonly limits: ExtractLimits;

  private constructor(
    zip: yauzl.ZipFile,
    entries: Map<string, yauzl.Entry>,
    limits: ExtractLimits,
  ) {
    this.zip = zip;
    this.entries = entries;
    this.limits = limits;
  }

  /** Reads the archive's directory. `malformed` if it isn't a ZIP; `archive-limits` if too many entries. */
  static async open(bytes: Uint8Array, limits: ExtractLimits): Promise<Archive> {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let zip: yauzl.ZipFile;
    try {
      zip = await yauzl.fromBufferPromise(buffer, {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false,
      });
    } catch (e) {
      throw new ExtractError("malformed", "not a readable ZIP archive", { cause: e });
    }
    if (zip.entryCount > limits.maxEntries) {
      zip.close();
      throw new ExtractError("archive-limits", "too many entries");
    }
    const entries = new Map<string, yauzl.Entry>();
    await new Promise<void>((resolve, reject) => {
      let seen = 0;
      const fail = (e: unknown) => {
        zip.close();
        reject(
          e instanceof ExtractError
            ? e
            : new ExtractError("malformed", "bad ZIP directory", { cause: e }),
        );
      };
      zip.on("error", fail);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        if (++seen > limits.maxEntries) return fail(new ExtractError("archive-limits"));
        // Part names are case-insensitive (OPC); the first of two that differ in case wins.
        const name = entry.fileName.toLowerCase();
        if (!entries.has(name)) entries.set(name, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
    return new Archive(zip, entries, limits);
  }

  /** Whether the archive has this part (names compare without case). */
  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** The part names, lower case, in directory order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * A part's bytes as they inflate, or nothing if there is no such part. Stop iterating to stop
   * inflating: the rest of the part is never read.
   */
  async *read(name: string): AsyncGenerator<Uint8Array> {
    const entry = this.entries.get(name.toLowerCase());
    if (entry === undefined) return;
    if (entry.isEncrypted()) throw new ExtractError("encrypted");
    const declared = entry.uncompressedSize;
    if (declared > this.limits.maxUncompressedBytes - this.used) {
      throw new ExtractError("archive-limits", "archive expands past the limit");
    }
    if (declared > MiB && declared > entry.compressedSize * this.limits.maxCompressionRatio) {
      throw new ExtractError("archive-limits", "compression ratio past the limit");
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new ExtractError("malformed", "unsupported compression method");
    }
    const stream = await new Promise<Readable>((resolve, reject) =>
      this.zip.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s))),
    ).catch((e: unknown) => {
      throw new ExtractError("malformed", "unreadable ZIP entry", { cause: e });
    });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        this.used += chunk.byteLength;
        if (this.used > this.limits.maxUncompressedBytes) {
          throw new ExtractError("archive-limits", "archive expands past the limit");
        }
        yield chunk;
      }
    } catch (e) {
      if (e instanceof ExtractError) throw e;
      // Inflated past its declared size, a bad CRC, or a broken deflate stream.
      throw new ExtractError("malformed", "bad ZIP entry data", { cause: e });
    } finally {
      stream.destroy();
    }
  }

  close(): void {
    this.zip.close();
  }
}
