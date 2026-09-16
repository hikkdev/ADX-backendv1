import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';

/**
 * How a dump is sealed — Lot E (decision 95).
 *
 * AES-256-GCM, a fresh 96-bit IV per file, the authentication tag appended
 * after the ciphertext. The layout:
 *
 *     "ADXB"  version(1)  iv(12)  ciphertext…  tag(16)
 *
 * GCM is authenticated, so a dump that was truncated, bit-flipped in transit
 * or sealed with a different key fails to open rather than restoring
 * garbage. The tag sits at the end because the file is written as a stream —
 * the tag only exists once the last byte has gone through the cipher — and
 * the reader takes it off the tail before it streams the middle.
 */

const MAGIC = Buffer.from('ADXB');
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES;

/**
 * The key from the environment: 32 bytes as 64 hex characters or as base64.
 * The error never carries the value it was given.
 */
export function parseBackupKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('BACKUP_KEY is not set: refusing to write or read a dump without it');
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32 && b64.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) return b64;
  throw new Error('BACKUP_KEY must be 32 bytes, as 64 hex characters or base64');
}

/** Seals `src` into `dst`. */
export async function encryptPlain(src: string, dst: string, key: Buffer): Promise<void> {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dst);
  out.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
  await pipeline(fs.createReadStream(src), cipher, out);
  await fs.promises.appendFile(dst, cipher.getAuthTag());
}

/** Opens `src` into `dst`, refusing anything that is not an intact ADX dump under this key. */
export async function decryptToPlain(src: string, dst: string, key: Buffer): Promise<void> {
  const { size } = await fs.promises.stat(src);
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error('not a sealed ADX dump: file too short');

  const handle = await fs.promises.open(src, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) {
    throw new Error('not a sealed ADX dump: bad header');
  }
  const iv = header.subarray(MAGIC.length + 1, HEADER_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  if (size === HEADER_BYTES + TAG_BYTES) {
    // An empty payload: nothing to stream, but the tag still has to check out.
    decipher.final();
    await fs.promises.writeFile(dst, Buffer.alloc(0));
    return;
  }

  await pipeline(
    fs.createReadStream(src, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
    decipher,
    fs.createWriteStream(dst),
  );
}
