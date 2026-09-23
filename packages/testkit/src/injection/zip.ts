import { inflateRawSync } from "node:zlib";

/*
 * Just enough ZIP for OOXML test files (DOCX, XLSX): a deterministic writer (stored entries,
 * fixed timestamps, so corpus bytes never change between runs) and a reader that handles
 * stored and deflated entries (what Office and LibreOffice produce).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP with stored (uncompressed) entries, in the given order. */
export function zip(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // 00:00
    lv.setUint16(12, 0x21, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

export interface UnzipLimits {
  /** Largest single entry after decompression. Default 32 MiB. */
  maxEntryBytes?: number;
  /** Largest total after decompression, across all entries. Default 128 MiB. */
  maxTotalBytes?: number;
  /** Most entries accepted. Default 10,000. */
  maxEntries?: number;
}

/**
 * Reads every entry of a ZIP (stored or deflated). Built for UNTRUSTED input: it enforces
 * per-entry, total and entry-count limits on the real decompressed size (never trusting the
 * declared one), and rejects archives whose entries overlap or reuse data (the "overlapping
 * files" zip bomb), whose local headers disagree with the central directory, or whose data
 * runs into the central directory.
 */
export function unzip(bytes: Uint8Array, limits: UnzipLimits = {}): Map<string, Uint8Array> {
  const maxEntryBytes = limits.maxEntryBytes ?? 32 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 128 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 10_000;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = u16(eocd + 10);
  const cdStart = u32(eocd + 16);
  if (count > maxEntries) throw new Error(`zip has too many entries (${count})`);
  if (cdStart + u32(eocd + 12) > eocd) throw new Error("corrupt central directory");

  const dec = new TextDecoder();
  const entries: {
    name: string;
    method: number;
    raw: Uint8Array;
    size: number;
    span: [number, number];
  }[] = [];
  const names = new Set<string>();
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || u32(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const compressed = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localAt = u32(p + 42);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = dec.decode(nameBytes);
    if (flags & 0x1) throw new Error(`zip entry ${name} is encrypted`);
    if (size > maxEntryBytes) throw new Error(`zip entry ${name} is too large (${size} bytes)`);
    if (names.has(name)) throw new Error(`duplicate zip entry ${name}`);
    names.add(name);

    if (localAt + 30 > cdStart || u32(localAt) !== 0x04034b50)
      throw new Error(`bad local header for ${name}`);
    const localNameLen = u16(localAt + 26);
    const localName = bytes.subarray(localAt + 30, localAt + 30 + localNameLen);
    if (localNameLen !== nameLen || !localName.every((b, k) => b === nameBytes[k])) {
      throw new Error(`local header name mismatch for ${name}`);
    }
    const dataAt = localAt + 30 + localNameLen + u16(localAt + 28);
    if (dataAt + compressed > cdStart) throw new Error(`zip entry ${name} runs past its data area`);
    if (method === 0 && compressed !== size) {
      throw new Error(`stored zip entry ${name} has inconsistent sizes`);
    }
    if (method !== 0 && method !== 8)
      throw new Error(`unsupported zip method ${method} for ${name}`);
    entries.push({
      name,
      method,
      raw: bytes.subarray(dataAt, dataAt + compressed),
      size,
      span: [localAt, dataAt + compressed],
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Entries must not overlap: shared data is how small archives expand to terabytes. Checked
  // before anything is decompressed.
  const spans = entries.map((e) => e.span).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < spans.length; k++) {
    if ((spans[k] as [number, number])[0] < (spans[k - 1] as [number, number])[1]) {
      throw new Error("zip entries overlap");
    }
  }

  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (const { name, method, raw, size } of entries) {
    let data = raw;
    if (method === 8) {
      // Cap at the declared size: a lying header can't make inflate produce more than we allow.
      data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }));
      if (data.length !== size)
        throw new Error(`zip entry ${name} does not match its declared size`);
    }
    total += data.length;
    if (total > maxTotalBytes) throw new Error(`zip expands past ${maxTotalBytes} bytes`);
    out.set(name, data);
  }
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
