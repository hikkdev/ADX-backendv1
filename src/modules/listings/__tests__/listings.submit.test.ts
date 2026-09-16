import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sending a listing for review.
 *
 * This is the step whose absence meant nothing on the platform could ever be
 * booked: a created listing takes the Prisma default DRAFT, inventory matching
 * only ever looks at ACTIVE, and the one route that promotes a listing was
 * declared in the mobile client and called by nothing at all. Supply and demand
 * were each fully built and were never joined.
 */

const { repository, pricing, rateCards } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    submitForReview: vi.fn(),
    displayIdExists: vi.fn(),
    countAll: vi.fn(),
    publish: vi.fn(),
  },
  pricing: { recordMarketDataPoint: vi.fn(), evaluate: vi.fn() },
  rateCards: { assertPublishable: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));

import { submitListingForReview } from '../listings.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  status: 'DRAFT',
  displayId: null,
  ...over,
});

const NOW = new Date('2026-09-09T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(listing());
  repository.countAll.mockResolvedValue(24017);
  repository.displayIdExists.mockResolvedValue(false);
  repository.submitForReview.mockImplementation(
    async (id: string, displayId: string | null, at: Date) => ({
      id,
      status: 'PENDING_REVIEW',
      displayId,
      submittedAt: at,
    })
  );
});

describe('submitting for review', () => {
  it('moves a draft to pending review and dates it', async () => {
    const result = await submitListingForReview('lst_1', NOW);
    expect(result.status).toBe('PENDING_REVIEW');
    expect(repository.submitForReview).toHaveBeenCalledWith('lst_1', 'ADX-LST-24018', NOW);
  });

  /* The reference AG-25 prints back. Its own allocator rather than the party
     one, which mints a different shape entirely. */
  it('mints the reference the confirmation screen shows', async () => {
    await submitListingForReview('lst_1', NOW);
    expect(repository.submitForReview.mock.calls[0]![1]).toBe('ADX-LST-24018');
  });

  it('steps past a reference somebody already holds', async () => {
    repository.displayIdExists.mockResolvedValueOnce(true).mockResolvedValue(false);
    await submitListingForReview('lst_1', NOW);
    expect(repository.submitForReview.mock.calls[0]![1]).toBe('ADX-LST-24019');
  });

  it('keeps the reference a listing already has', async () => {
    repository.findById.mockResolvedValue(listing({ displayId: 'ADX-LST-00007' }));
    await submitListingForReview('lst_1', NOW);
    expect(repository.submitForReview.mock.calls[0]![1]).toBe('ADX-LST-00007');
    expect(repository.countAll).not.toHaveBeenCalled();
  });

  /* Submit is on a screen somebody will press twice. */
  it('is idempotent once already under review', async () => {
    repository.findById.mockResolvedValue(listing({ status: 'PENDING_REVIEW' }));
    const result = await submitListingForReview('lst_1', NOW);
    expect(result.status).toBe('PENDING_REVIEW');
    expect(repository.submitForReview).not.toHaveBeenCalled();
  });

  /* Submitting is not publishing: the publisher says they are done, ADX decides
     whether it goes on the marketplace. */
  it('refuses to re-submit something already live', async () => {
    repository.findById.mockResolvedValue(listing({ status: 'ACTIVE' }));
    await expect(submitListingForReview('lst_1', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a listing that is not there', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(submitListingForReview('nope', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});
