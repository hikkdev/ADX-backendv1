import { decodeThumbnail, dhash, hasThumbnailDecoder, isDuplicate } from './dhash';
import type { FraudSignal, LinkedParty, ListingPhotoRef } from './types';

/** How many other publishers' photos are hashed for the comparison. */
export const OTHERS_PHOTO_LIMIT = 500;

async function hashAll(photos: ListingPhotoRef[]): Promise<{ photo: ListingPhotoRef; hash: string }[]> {
  const out: { photo: ListingPhotoRef; hash: string }[] = [];
  for (const photo of photos) {
    const image = await decodeThumbnail(photo.url);
    if (image) out.push({ photo, hash: dhash(image) });
  }
  return out;
}

/**
 * The same board photographed on two publishers' listings — a perceptual
 * hash within a few bits. Needs the image decoder (`sharp`, G10 —
 * `thumbnail-decoder.ts`, installed at boot): without one the signal
 * answers null and contributes nothing to the score, rather than guessing.
 */
export const duplicateListingPhotosSignal: FraudSignal = {
  key: 'DUPLICATE_LISTING_PHOTOS',
  weight: 0.3,
  async evaluate(subject, { index }) {
    if (subject.type !== 'PUBLISHER') return { value: 0, detail: 'Only a publisher has listing photos.' };
    if (!hasThumbnailDecoder()) {
      return { value: null, detail: 'Photo comparison unavailable: no image decoder is registered (sharp). Signal not computed.' };
    }
    const own = await index.listingPhotosFor(subject.id);
    const mine = subject.listingId ? own.filter((p) => p.listingId === subject.listingId) : own;
    if (mine.length === 0) return { value: 0, detail: 'No listing photos to compare.' };
    const [ownHashes, otherHashes] = await Promise.all([
      hashAll(mine),
      index.listingPhotosOfOthers(subject.id, OTHERS_PHOTO_LIMIT).then(hashAll),
    ]);
    // G13-B: every publisher whose photos were actually hashed and compared,
    // matched or not — the registry caps what is stored.
    const compared = new Map<string, LinkedParty>();
    for (const { photo } of otherHashes) {
      if (!compared.has(photo.publisherId)) compared.set(photo.publisherId, { type: 'PUBLISHER', id: photo.publisherId, name: photo.publisherName ?? null });
    }
    const candidates = [...compared.values()];
    const linked = new Map<string, LinkedParty>();
    let duplicates = 0;
    for (const a of ownHashes) {
      for (const b of otherHashes) {
        if (isDuplicate(a.hash, b.hash)) {
          duplicates += 1;
          linked.set(b.photo.publisherId, { type: 'PUBLISHER', id: b.photo.publisherId, name: b.photo.publisherName ?? null });
        }
      }
    }
    if (duplicates === 0) return { value: 0, detail: `None of ${ownHashes.length} photos matches another publisher's.`, candidates };
    return {
      value: 1,
      detail: `${duplicates} listing ${duplicates === 1 ? 'photo matches' : 'photos match'} photos on ${linked.size} other ${linked.size === 1 ? 'publisher' : 'publishers'}.`,
      links: [...linked.values()],
      candidates,
    };
  },
};
