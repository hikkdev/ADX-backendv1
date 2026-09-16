import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-2: each spot on GET /campaigns/:id says whether it was reviewed.
 *
 * `reviews` imports this module, so the answer comes through a port
 * bootstrap fills; unregistered, every spot reads as unreviewed; a port
 * that fails leaves the spots unmarked rather than failing the read.
 */

import { registerSpotReviewPort, resetSpotReviewPort, withSpotReviews } from '../spot-review.port';

const campaign = () => ({
  id: 'cmp_1',
  name: 'Monsoon',
  spots: [
    { id: 'spot_1', listingId: 'lst_1', status: 'COMPLETED' },
    { id: 'spot_2', listingId: 'lst_2', status: 'COMPLETED' },
  ],
});

afterEach(() => resetSpotReviewPort());

describe('withSpotReviews', () => {
  it('marks the spots the port names, with the review id, and the rest unreviewed', async () => {
    const port = { reviewIdsForSpots: vi.fn(async () => new Map([['spot_2', 'rev_9']])) };
    registerSpotReviewPort(port);
    const marked = await withSpotReviews(campaign());
    expect(port.reviewIdsForSpots).toHaveBeenCalledWith(['spot_1', 'spot_2']);
    expect(marked.spots).toEqual([
      { id: 'spot_1', listingId: 'lst_1', status: 'COMPLETED', reviewed: false, reviewId: null },
      { id: 'spot_2', listingId: 'lst_2', status: 'COMPLETED', reviewed: true, reviewId: 'rev_9' },
    ]);
    expect(marked.name).toBe('Monsoon');
  });

  it('reads every spot as unreviewed when nothing is registered, and when the port fails', async () => {
    let marked = await withSpotReviews(campaign());
    expect(marked.spots.every((spot) => spot.reviewed === false && spot.reviewId === null)).toBe(true);

    registerSpotReviewPort({ reviewIdsForSpots: async () => { throw new Error('down'); } });
    marked = await withSpotReviews(campaign());
    expect(marked.spots.every((spot) => spot.reviewed === false)).toBe(true);
  });
});
