import { describe, expect, it } from 'vitest';
import { coverFirst, coverPhotoUrlOf } from '../photos';

/**
 * 3 Oct 2026: `ListingPhoto` has no order or cover column. The wizards file
 * FRONT / LEFT / RIGHT / WIDE and the photos door "main"; the front (or the
 * main) one leads, the rest keep the order they were filed in, and a
 * listing with neither leads with its first.
 */
describe('the cover photograph', () => {
  const photo = (url: string, type: string) => ({ url, type });

  it('puts the front one first and keeps the rest in filing order', () => {
    const photos = [photo('a', 'LEFT'), photo('b', 'RIGHT'), photo('c', 'FRONT'), photo('d', 'WIDE')];
    expect(coverFirst(photos).map((p) => p.url)).toEqual(['c', 'a', 'b', 'd']);
    expect(coverPhotoUrlOf(photos)).toBe('c');
  });

  it('takes "main" as the cover too, whatever its case', () => {
    expect(coverPhotoUrlOf([photo('a', 'LEFT'), photo('b', 'main')])).toBe('b');
  });

  it('leads with the first filed when none is marked, and is null with none', () => {
    expect(coverPhotoUrlOf([photo('a', 'LEFT'), photo('b', 'WIDE')])).toBe('a');
    expect(coverPhotoUrlOf([])).toBeNull();
    expect(coverPhotoUrlOf(undefined)).toBeNull();
  });
});
