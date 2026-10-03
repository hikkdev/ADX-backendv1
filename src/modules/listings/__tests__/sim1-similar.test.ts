import { describe, expect, it } from 'vitest';
import { similarAnchor, similarWhere } from '../prisma-listings.repository';

/**
 * SIM-1 (the owner, 27 Sep 2026): the listing page's "Similar listing" row
 * scrolls, and "View all similar listings" opens the full set. Both read the
 * one rule: the anchor's category, in its city, within ±30% of its monthly
 * price, live, rights in force, never the anchor itself.
 */
describe('similar to a listing', () => {
  const anchor = similarAnchor({ id: 'lst_1', cityId: 'city_blr', city: 'Bengaluru', category: 'OUTDOOR', monthlyPrice: 100000 });

  it('is its category, in its city by key, within ±30% of its price, and never itself', () => {
    expect(similarWhere(anchor)).toEqual({
      id: { not: 'lst_1' },
      cityId: 'city_blr',
      category: 'OUTDOOR',
      status: 'ACTIVE',
      rightsLapsedAt: null,
      monthlyPrice: { gte: 70000, lte: 130000 },
    });
  });

  it('falls back to the city string when the listing carries no key', () => {
    const where = similarWhere(similarAnchor({ id: 'lst_2', cityId: null, city: 'Pune', category: 'MEDIA', monthlyPrice: 5000 }));
    expect(where).toMatchObject({ city: 'Pune', category: 'MEDIA' });
    expect(where).not.toHaveProperty('cityId');
  });
});
