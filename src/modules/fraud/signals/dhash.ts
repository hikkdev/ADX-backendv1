/**
 * A difference hash (dHash) over a grayscale thumbnail — Lot G (Q138).
 *
 * The hash is 64 bits: the image is reduced to 9×8 grayscale, and each bit
 * says whether a pixel is brighter than its right-hand neighbour. Two photos
 * of the same board hash within a few bits of each other whatever the
 * re-encoding; two different boards do not. This file is the arithmetic
 * only — it takes pixels, not files. Decoding a JPEG or PNG into pixels is
 * `sharp`'s job (G10: `thumbnail-decoder.ts`, registered at boot);
 * `decodeThumbnail` below is the seam, and answers null until one is
 * registered, so the DUPLICATE_LISTING_PHOTOS signal reads null rather than
 * guessing.
 */

export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;

/** A grayscale image as row-major 0..255 values. */
export type GrayImage = { width: number; height: number; pixels: Uint8Array | number[] };

/** Nearest-neighbour resample to the 9×8 grid the hash reads. */
export function resampleGray(image: GrayImage, width = DHASH_WIDTH, height = DHASH_HEIGHT): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
      out.push(image.pixels[sy * image.width + sx] ?? 0);
    }
  }
  return out;
}

/** The 64-bit hash as 16 hex characters. */
export function dhash(image: GrayImage): string {
  const grid = resampleGray(image);
  let bits = '';
  for (let y = 0; y < DHASH_HEIGHT; y += 1) {
    for (let x = 0; x < DHASH_WIDTH - 1; x += 1) {
      const left = grid[y * DHASH_WIDTH + x] ?? 0;
      const right = grid[y * DHASH_WIDTH + x + 1] ?? 0;
      bits += left > right ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** How many bits differ between two hashes. */
export function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16);
    distance += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return distance;
}

/** Two hashes within this many bits are the same photo. */
export const DUPLICATE_DISTANCE = 6;

export const isDuplicate = (a: string, b: string) => hammingDistance(a, b) <= DUPLICATE_DISTANCE;

/**
 * The decoder seam: a thumbnail's grayscale pixels from its URL. Nothing is
 * registered until bootstrap installs the sharp decoder (G10), and a test
 * registers its own; unregistered, the signal reports itself unavailable.
 */
export type ThumbnailDecoder = (url: string) => Promise<GrayImage | null>;

let decoder: ThumbnailDecoder | null = null;

export function registerThumbnailDecoder(fn: ThumbnailDecoder | null): void {
  decoder = fn;
}

export const hasThumbnailDecoder = () => decoder !== null;

export async function decodeThumbnail(url: string): Promise<GrayImage | null> {
  if (!decoder) return null;
  try {
    return await decoder(url);
  } catch {
    return null;
  }
}
