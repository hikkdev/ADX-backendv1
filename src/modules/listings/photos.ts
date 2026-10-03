/**
 * Which photograph leads (3 Oct 2026).
 *
 * `ListingPhoto` has no order or cover column: the photographs come in the
 * order they were filed (`createdAt`), and the type says which angle each
 * is. The wizards file FRONT / LEFT / RIGHT / WIDE; the photos door and the
 * imports file "main". The front (or the main) one is the cover; a listing
 * with neither leads with the first one filed.
 */
const COVER_TYPES = new Set(['MAIN', 'FRONT', 'COVER']);

export function coverFirst<T extends { type: string }>(photos: readonly T[]): T[] {
  const index = photos.findIndex((photo) => COVER_TYPES.has(photo.type.toUpperCase()));
  if (index <= 0) return [...photos];
  return [photos[index]!, ...photos.slice(0, index), ...photos.slice(index + 1)];
}

/** The cover's URL, or null for a listing with no photograph. */
export function coverPhotoUrlOf(photos: readonly { url: string; type: string }[] | null | undefined): string | null {
  return photos?.length ? (coverFirst(photos)[0]?.url ?? null) : null;
}
