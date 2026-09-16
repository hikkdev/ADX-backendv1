import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer — G6 (Q104).
 *
 * The data export is "one JSON file plus a README.txt inside a zip" and the
 * build has no zip library (`node:zlib` is deflate, not zip). The container
 * is small enough to write by hand: a local header per entry, the deflated
 * bytes, a central directory and the end record. Every entry is DEFLATE
 * (method 8) with the UTF-8 name flag set; no ZIP64, so the archive and any
 * entry must stay under 4 GB — a person's records are kilobytes.
 *
 * `readZip` is the inverse, for the test and for nothing else in
 * production: it walks the central directory and inflates each entry.
 */

export interface ZipEntry {
  /** Forward slashes; no leading slash. */
  name: string;
  data: Buffer | string;
  mtime?: Date;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const VERSION = 20;
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;

/** MS-DOS time and date, as the format wants them (two-second resolution, 1980 epoch). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

export function zipFiles(entries: readonly ZipEntry[], now = new Date()): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const compressed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const { time, date } = dosDateTime(entry.mtime ?? now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/** The entries of an archive written by `zipFiles` (or any single-disk, non-ZIP64 zip with DEFLATE or STORED entries). */
export function readZip(archive: Buffer): { name: string; data: Buffer }[] {
  const endAt = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Not a zip archive: no end record');
  const count = archive.readUInt16LE(endAt + 10);
  let cursor = archive.readUInt32LE(endAt + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error('Corrupt central directory');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    out.push({ name, data: method === METHOD_DEFLATE ? inflateRawSync(raw) : Buffer.from(raw) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
