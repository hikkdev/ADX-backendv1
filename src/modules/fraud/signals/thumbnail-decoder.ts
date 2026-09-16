import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { logger } from '../../../shared/logging';
import { DHASH_HEIGHT, DHASH_WIDTH, registerThumbnailDecoder, type GrayImage, type ThumbnailDecoder } from './dhash';

/**
 * G10: the image decoder behind DUPLICATE_LISTING_PHOTOS — `sharp`, wired
 * into the `dhash` seam at boot by `installThumbnailDecoder()`.
 *
 * A listing photo is a public URL: `<baseUrl>/uploads/<file>` on the local
 * storage provider, the bucket's public host on R2. The bytes come off disk
 * for the local layout (the storage adapter's own `uploads/` directory —
 * no round trip through the process's own HTTP door) and over HTTP with a
 * five-second timeout for everything else. `sharp` then reduces them to the
 * 9×8 grayscale grid the hash reads: `grayscale().resize(9, 8, { fit: 'fill' })
 * .raw()` — the whole image squashed onto the grid, not cropped, because a
 * re-encoded or slightly recropped copy of the same board must still hash
 * within a few bits.
 *
 * Every failure — a URL nothing answers, a file that is not an image, a
 * timeout — is a null through the seam, which the signal reads as "this
 * photo could not be compared", never as a match and never as a crash of
 * the nightly scan.
 */

export const THUMBNAIL_FETCH_TIMEOUT_MS = 5_000;
/** A listing photo bigger than this is not read: the hash needs a thumbnail, not the original. */
export const THUMBNAIL_MAX_BYTES = 20 * 1024 * 1024;

/** Where the bytes come from — the seam the tests fill with generated PNGs. */
export type ByteSource = (url: string) => Promise<Buffer | null>;

const UPLOADS_DIR = () => path.join(process.cwd(), 'uploads');

/** The local file behind a `/uploads/<file>` URL, or null when the URL is not one (or escapes the directory). */
export function localUploadPath(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith('/uploads/')) return null;
  const relative = decodeURIComponent(pathname.slice('/uploads/'.length));
  const target = path.resolve(UPLOADS_DIR(), relative);
  return target.startsWith(UPLOADS_DIR() + path.sep) ? target : null;
}

/** Off disk for the local provider's layout; over HTTP, five seconds at most, for everything else. */
export async function fetchPhotoBytes(url: string): Promise<Buffer | null> {
  const local = localUploadPath(url);
  if (local) {
    try {
      return await fs.readFile(local);
    } catch {
      /* not on this disk — perhaps served from another instance; fall through to HTTP */
    }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > THUMBNAIL_MAX_BYTES) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length > THUMBNAIL_MAX_BYTES ? null : bytes;
}

/** The 9×8 grayscale grid off any image sharp can read. Throws on bytes that are not one. */
export async function decodeWithSharp(bytes: Buffer): Promise<GrayImage> {
  const { data, info } = await sharp(bytes, { failOn: 'none' })
    .removeAlpha()
    .grayscale()
    .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = Math.max(1, info.channels);
  const pixels = new Uint8Array(info.width * info.height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = data[i * channels] ?? 0;
  return { width: info.width, height: info.height, pixels };
}

/** The decoder the seam takes: bytes from `source`, pixels from sharp; null on any failure. */
export function sharpThumbnailDecoder(source: ByteSource = fetchPhotoBytes): ThumbnailDecoder {
  return async (url) => {
    try {
      const bytes = await source(url);
      if (!bytes || bytes.length === 0) return null;
      return await decodeWithSharp(bytes);
    } catch (err) {
      logger.debug('Listing photo not decoded for the duplicate-photo signal', { url, cause: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
}

/** Bootstrap calls this once: from here on DUPLICATE_LISTING_PHOTOS computes. */
export function installThumbnailDecoder(): void {
  registerThumbnailDecoder(sharpThumbnailDecoder());
}
