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

const { repository, pricing, rateCards, identifiers } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    submitForReview: vi.fn(),
    displayIdExists: vi.fn(),
    countAll: vi.fn(),
    publish: vi.fn(),
  },
  pricing: { recordMarketDataPoint: vi.fn(), evaluate: vi.fn() },
  rateCards: { assertPublishable: vi.fn() },
  // QR-8: the reference comes off the LISTING series now, not a row count.
  identifiers: { allocateIdentifier: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../identifiers', () => identifiers);

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
  identifiers.allocateIdentifier.mockResolvedValue('LST-0909-2601');
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
    expect(repository.submitForReview).toHaveBeenCalledWith('lst_1', 'LST-0909-2601', NOW);
  });

  /* The reference AG-25 prints back. QR-8: a row from before QR-8 with no
     reference yet is minted one from the LISTING series at submit — the
     same series a new listing draws from at creation. */
  it('mints the reference the confirmation screen shows, off the LISTING series', async () => {
    await submitListingForReview('lst_1', NOW);
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('LISTING');
    expect(repository.submitForReview.mock.calls[0]![1]).toBe('LST-0909-2601');
  });

  it('keeps the reference a listing already has — the old ADX-LST-nnnnn included', async () => {
    repository.findById.mockResolvedValue(listing({ displayId: 'ADX-LST-00007' }));
    await submitListingForReview('lst_1', NOW);
    expect(repository.submitForReview.mock.calls[0]![1]).toBe('ADX-LST-00007');
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
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
