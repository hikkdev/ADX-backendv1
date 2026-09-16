import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { dhash, decodeThumbnail, hasThumbnailDecoder, isDuplicate, registerThumbnailDecoder } from '../signals/dhash';
import { duplicateListingPhotosSignal } from '../signals/duplicate-listing-photos.signal';
import { decodeWithSharp, installThumbnailDecoder, sharpThumbnailDecoder } from '../signals/thumbnail-decoder';
import type { FraudSignalIndex, ResolvedSubject } from '../signals/types';

/**
 * G10: the thumbnail decoder behind DUPLICATE_LISTING_PHOTOS is sharp, wired
 * at boot. What is pinned, on PNGs sharp itself generates: the decoder
 * reduces an image to the 9×8 grayscale grid the hash reads; two identical
 * images score 1 through the signal; two different images score 0; a fetch
 * that fails, or bytes that are not an image, answer null rather than throw.
 */

async function png(fill: { r: number; g: number; b: number }, stripe = false): Promise<Buffer> {
  const width = 64;
  const height = 48;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      // A left-to-right gradient so the hash has structure; the stripe flips it.
      const shade = stripe ? (Math.floor(x / 8) % 2 === 0 ? 255 : 0) : Math.round((x / (width - 1)) * 255);
      raw[i] = Math.min(255, (fill.r + shade) / 2);
      raw[i + 1] = Math.min(255, (fill.g + shade) / 2);
      raw[i + 2] = Math.min(255, (fill.b + shade) / 2);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const publisher: ResolvedSubject = {
  type: 'PUBLISHER',
  id: 'pub_1',
  userId: 'usr_1',
  name: 'Asha',
  mobile: null,
  pan: null,
  kycStatus: null,
  agentId: null,
  listingId: null,
};

const empty = (): FraudSignalIndex =>
  ({
    listingPhotosFor: async () => [],
    listingPhotosOfOthers: async () => [],
  }) as unknown as FraudSignalIndex;

afterEach(() => registerThumbnailDecoder(null));

describe('decodeWithSharp', () => {
  it('reduces a PNG to the 9×8 grayscale grid', async () => {
    const image = await decodeWithSharp(await png({ r: 200, g: 40, b: 40 }));
    expect(image).toMatchObject({ width: 9, height: 8 });
    expect(image.pixels).toHaveLength(72);
    // The gradient survives the resize: the left column is darker than the right.
    expect(image.pixels[0]!).toBeLessThan(image.pixels[8]!);
  });

  it('answers null through the seam for bytes that are not an image or a source that fails', async () => {
    registerThumbnailDecoder(sharpThumbnailDecoder(async () => Buffer.from('not a picture')));
    expect(await decodeThumbnail('x')).toBeNull();
    registerThumbnailDecoder(sharpThumbnailDecoder(async () => null));
    expect(await decodeThumbnail('x')).toBeNull();
    registerThumbnailDecoder(
      sharpThumbnailDecoder(async () => {
        throw new Error('timeout');
      }),
    );
    expect(await decodeThumbnail('x')).toBeNull();
  });
});

describe('DUPLICATE_LISTING_PHOTOS with the sharp decoder', () => {
  it('scores 1 for two identical images and 0 for two different ones', async () => {
    const same = await png({ r: 200, g: 40, b: 40 });
    const other = await png({ r: 40, g: 40, b: 200 }, true);
    const bytes: Record<string, Buffer> = { 'https://cdn.adx.test/a.png': same, 'https://cdn.adx.test/b.png': Buffer.from(same), 'https://cdn.adx.test/c.png': other };
    registerThumbnailDecoder(sharpThumbnailDecoder(async (url) => bytes[url] ?? null));
    expect(hasThumbnailDecoder()).toBe(true);

    const a = dhash((await decodeThumbnail('https://cdn.adx.test/a.png'))!);
    const b = dhash((await decodeThumbnail('https://cdn.adx.test/b.png'))!);
    const c = dhash((await decodeThumbnail('https://cdn.adx.test/c.png'))!);
    expect(isDuplicate(a, b)).toBe(true);
    expect(isDuplicate(a, c)).toBe(false);

    const identical = {
      ...empty(),
      listingPhotosFor: async () => [{ listingId: 'l1', publisherId: 'pub_1', url: 'https://cdn.adx.test/a.png' }],
      listingPhotosOfOthers: async () => [{ listingId: 'l7', publisherId: 'pub_7', url: 'https://cdn.adx.test/b.png' }],
    };
    expect(await duplicateListingPhotosSignal.evaluate(publisher, { index: identical, now: new Date() })).toMatchObject({
      value: 1,
      links: [{ type: 'PUBLISHER', id: 'pub_7' }],
    });

    const different = {
      ...empty(),
      listingPhotosFor: async () => [{ listingId: 'l1', publisherId: 'pub_1', url: 'https://cdn.adx.test/a.png' }],
      listingPhotosOfOthers: async () => [{ listingId: 'l8', publisherId: 'pub_8', url: 'https://cdn.adx.test/c.png' }],
    };
    expect(await duplicateListingPhotosSignal.evaluate(publisher, { index: different, now: new Date() })).toMatchObject({ value: 0 });
  });

  it('installThumbnailDecoder registers the sharp decoder for the signal', () => {
    expect(hasThumbnailDecoder()).toBe(false);
    installThumbnailDecoder();
    expect(hasThumbnailDecoder()).toBe(true);
  });
});
