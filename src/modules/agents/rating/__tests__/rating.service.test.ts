import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q112) — the publishers' stars reach the rating.
 *
 * What is pinned: the score reads the review snapshot columns `reviews`
 * writes, the ledger reads the recent reviews through the port, an
 * unregistered port costs only the ledger rows, and `setAgentReviewSnapshot`
 * moves exactly the two review columns.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findAgent: vi.fn(),
    assignmentTotals: vi.fn(),
    arrivals: vi.fn(),
    recentOffers: vi.fn(),
    recentCompletions: vi.fn(),
    recentRejections: vi.fn(),
    saveSnapshot: vi.fn(),
    cohortScores: vi.fn(),
    reviewSnapshot: vi.fn(),
    saveReviewSnapshot: vi.fn(),
  },
}));

vi.mock('../prisma-rating.repository', () => ({ prismaRatingRepository: repository }));

import { ratingFor, setAgentReviewSnapshot } from '../rating.service';
import { registerAgentReviewPort, resetAgentReviewPort } from '../review-feed.port';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAgent.mockResolvedValue({ id: 'agt_1', city: 'Bengaluru' });
  repository.assignmentTotals.mockResolvedValue({ accepted: 20, completed: 19 });
  repository.arrivals.mockResolvedValue([]);
  repository.recentOffers.mockResolvedValue(Array.from({ length: 24 }, (_, i) => ({ status: i < 2 ? 'REJECTED' : 'ACCEPTED' })));
  repository.recentCompletions.mockResolvedValue([]);
  repository.recentRejections.mockResolvedValue([]);
  repository.saveSnapshot.mockResolvedValue(undefined);
  repository.cohortScores.mockResolvedValue([]);
  repository.reviewSnapshot.mockResolvedValue({ reviewAvg: null, reviewCount: 0 });
  repository.saveReviewSnapshot.mockResolvedValue(undefined);
});

afterEach(() => resetAgentReviewPort());

describe('ratingFor', () => {
  it('scores the fourth driver from the snapshot columns and lists the stars through the port', async () => {
    repository.reviewSnapshot.mockResolvedValue({ reviewAvg: 5, reviewCount: 3 });
    registerAgentReviewPort({
      recentReviews: async () => [{ reviewId: 'rev_1', rating: 5, note: 'Sharp', at: new Date('2026-09-10T10:00:00.000Z'), publisherName: 'Suraj Kumar Prints' }],
    });
    const unrated = await ratingFor('agt_1');
    repository.reviewSnapshot.mockResolvedValue({ reviewAvg: null, reviewCount: 0 });
    resetAgentReviewPort();
    const before = await ratingFor('agt_1');

    expect(unrated.drivers.find((driver) => driver.key === 'review')).toMatchObject({ rate: 1, sample: 3 });
    expect(unrated.score).toBeGreaterThan(before.score as number);
    expect(unrated.ledger[0]).toMatchObject({ id: 'review:rev_1', kind: 'review', delta: 0.1 });
    expect(before.ledger).toEqual([]);
    // E7-3: the snapshot columns ride on the read — the average as a decimal string, null before a first star.
    expect(unrated).toMatchObject({ reviewAvg: '5.00', reviewCount: 3 });
    expect(before).toMatchObject({ reviewAvg: null, reviewCount: 0 });
    // The derived snapshot never carries the review columns: they are `reviews`' to move.
    expect(repository.saveSnapshot.mock.calls[0]![0]).not.toHaveProperty('reviewAvg');
  });
});

describe('setAgentReviewSnapshot', () => {
  it('writes the two review columns for a known agent, as decimal strings', async () => {
    await setAgentReviewSnapshot('agt_1', { reviewAvg: '4.50', reviewCount: 2 });
    expect(repository.saveReviewSnapshot).toHaveBeenCalledWith('agt_1', 'Bengaluru', { reviewAvg: '4.50', reviewCount: 2 });
  });

  it('is a 404 for an agent that does not exist', async () => {
    repository.findAgent.mockResolvedValue(null);
    await expect(setAgentReviewSnapshot('agt_x', { reviewAvg: null, reviewCount: 0 })).rejects.toMatchObject({ statusCode: 404 });
  });
});
