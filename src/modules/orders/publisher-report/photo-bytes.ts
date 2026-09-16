import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../shared/logging';
import { fileIdFromUrl, openStoredFile } from '../../uploads';

/**
 * The bytes behind an evidence photo, for the thumbnail in the report — G6
 * (Q110). Three kinds of URL reach an order: a private `/files/:id` (opened
 * through `uploads` on a route that already authorised the read), a local
 * `/uploads/<name>` from the disk provider (read straight off the disk —
 * cheaper than a loopback request, and works before the server is up), and
 * a public R2 URL (fetched). pdfkit draws JPEG and PNG only; anything else,
 * or anything that cannot be reached in time, is a caption instead of a
 * picture — the report is never refused for a missing thumbnail.
 */

export const PHOTO_FETCH_TIMEOUT_MS = 8_000;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export type PhotoBytes = { kind: 'jpeg' | 'png'; data: Buffer } | null;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function imageKind(data: Buffer): 'jpeg' | 'png' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

function asPhoto(data: Buffer): PhotoBytes {
  if (data.length === 0 || data.length > PHOTO_MAX_BYTES) return null;
  const kind = imageKind(data);
  return kind ? { kind, data } : null;
}

async function fetchBytes(url: string, fetchImpl: Fetch): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > PHOTO_MAX_BYTES) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    logger.info('Evidence photo not fetched for the report', { url: url.slice(0, 120), reason: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A local `/uploads/<name>` URL read off the disk provider's directory, when the file is there. */
function localUploadPath(url: string): string | null {
  const match = /\/uploads\/([^/?#]+)(?:[?#]|$)/.exec(url);
  if (!match) return null;
  const name = path.basename(decodeURIComponent(match[1]!));
  const full = path.join(process.cwd(), 'uploads', name);
  return fs.existsSync(full) ? full : null;
}

export async function photoBytes(url: string, fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<PhotoBytes> {
  if (!url) return null;
  try {
    const fileId = fileIdFromUrl(url);
    if (fileId) {
      const opened = await openStoredFile(fileId);
      if (!opened) return null;
      if (opened.kind === 'stream') return asPhoto(await fs.promises.readFile(opened.path));
      const fetched = await fetchBytes(opened.url, fetchImpl);
      return fetched ? asPhoto(fetched) : null;
    }
    const local = localUploadPath(url);
    if (local) return asPhoto(await fs.promises.readFile(local));
    if (/^https?:\/\//i.test(url)) {
      const fetched = await fetchBytes(url, fetchImpl);
      return fetched ? asPhoto(fetched) : null;
    }
    return null;
  } catch (err) {
    logger.info('Evidence photo not read for the report', { url: url.slice(0, 120), reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
