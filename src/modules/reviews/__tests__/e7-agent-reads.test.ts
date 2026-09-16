import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-2 — the three reads the phones asked of the reviews module.
 *
 *   /agents/me/reviews   the agent's own stars, PUBLISHED only, on the list
 *                        contract, each row anchored on its order and the
 *                        publisher never named;
 *   the ledger feed      `recentAgentReviews` now carries the publisher's
 *                        name — the rating ledger is the one place it shows;
 *   the spot marks       `reviewIdsForCampaignSpots` behind campaigns' port:
 *                        which spots carry a review, any status.
 */

const { repository, campaigns, listings, orders, agents, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findByAnchor: vi.fn(),
    findByAnchors: vi.fn(),
    create: vi.fn(),
    publisherHasRatedAgent: vi.fn(),
    aggregate: vi.fn(),
    listPublished: vi.fn(),
    listForAdmin: vi.fn(),
    setStatus: vi.fn(),
    recentForAgent: vi.fn(),
    publisherNames: vi.fn(),
  },
  campaigns: { assertMayAct: vi.fn(), findCampaignSpotForReview: vi.fn() },
  listings: { getListingWithPublisher: vi.fn(), setListingRatingSnapshot: vi.fn() },
  orders: { getOrderSummary: vi.fn() },
  agents: { setAgentReviewSnapshot: vi.fn() },
  notifications: { createNotification: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
}));

vi.mock('../prisma-reviews.repository', () => ({ prismaReviewsRepository: repository }));
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../listings', () => listings);
vi.mock('../../orders', () => orders);
vi.mock('../../agents', () => agents);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);

import { myAgentReviews, recentAgentReviews, reviewIdsForCampaignSpots } from '../reviews.service';
import { myAgentReviewsQuerySchema } from '../reviews.schema';

const review = (over: Record<string, unknown> = {}) => ({
  id: 'rev_1',
  subjectType: 'AGENT',
  subjectId: 'agt_1',
  authorUserId: 'usr_pub',
  authorPublisherId: 'pub_1',
  authorAdvertiserId: null,
  anchorKind: 'ORDER',
  anchorId: 'ord_1',
  rating: 5,
  note: 'Quick and tidy',
  status: 'PUBLISHED',
  hiddenReason: null,
  hiddenById: null,
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.listPublished.mockResolvedValue({ items: [review(), review({ id: 'rev_2', anchorId: 'ord_2', rating: 3, note: null })], total: 2 });
  repository.recentForAgent.mockResolvedValue([review(), review({ id: 'rev_3', authorPublisherId: null })]);
  repository.publisherNames.mockResolvedValue(new Map([['pub_1', 'Suraj Kumar Prints']]));
  repository.findByAnchors.mockResolvedValue([review({ id: 'rev_9', subjectType: 'LISTING', anchorKind: 'CAMPAIGN_SPOT', anchorId: 'spot_2', status: 'HIDDEN' })]);
});

describe('GET /agents/me/reviews', () => {
  it('is the list contract over PUBLISHED reviews of the agent, one chip, the order named and the publisher not', async () => {
    const query = myAgentReviewsQuerySchema.parse({ q: 'tidy', sort: 'OLDEST', page: '2', pageSize: '10' });
    const page = await myAgentReviews('agt_1', query);
    expect(repository.listPublished).toHaveBeenCalledWith('AGENT', 'agt_1', 2, 10, { q: 'tidy', sort: 'OLDEST' });
    expect(page).toEqual({
      items: [
        { id: 'rev_1', rating: 5, note: 'Quick and tidy', createdAt: new Date('2026-09-10T10:00:00.000Z'), orderId: 'ord_1' },
        { id: 'rev_2', rating: 3, note: null, createdAt: new Date('2026-09-10T10:00:00.000Z'), orderId: 'ord_2' },
      ],
      total: 2,
      page: 2,
      pageSize: 10,
      counts: { PUBLISHED: 2 },
    });
    for (const item of page.items) {
      expect(item).not.toHaveProperty('authorPublisherId');
      expect(item).not.toHaveProperty('publisherName');
      expect(item).not.toHaveProperty('authorUserId');
    }
  });

  it('knows only PUBLISHED as a status and the two sorts', () => {
    expect(myAgentReviewsQuerySchema.parse({}).sort).toBe('NEWEST');
    expect(myAgentReviewsQuerySchema.parse({ status: 'PUBLISHED' }).status).toEqual(['PUBLISHED']);
    expect(myAgentReviewsQuerySchema.safeParse({ status: 'HIDDEN' }).success).toBe(false);
    expect(myAgentReviewsQuerySchema.safeParse({ sort: 'RATING' }).success).toBe(false);
  });
});

describe('the ledger feed', () => {
  it('names the publisher who rated, and null when there is none to name', async () => {
    const rows = await recentAgentReviews('agt_1', new Date('2026-08-01T00:00:00.000Z'));
    expect(repository.publisherNames).toHaveBeenCalledWith(['pub_1']);
    expect(rows).toEqual([
      { reviewId: 'rev_1', rating: 5, note: 'Quick and tidy', at: new Date('2026-09-10T10:00:00.000Z'), publisherName: 'Suraj Kumar Prints' },
      { reviewId: 'rev_3', rating: 5, note: 'Quick and tidy', at: new Date('2026-09-10T10:00:00.000Z'), publisherName: null },
    ]);
  });
});

describe('the spot marks', () => {
  it('answers spot id → review id for the anchors that carry one, hidden included', async () => {
    const marks = await reviewIdsForCampaignSpots(['spot_1', 'spot_2']);
    expect(repository.findByAnchors).toHaveBeenCalledWith('CAMPAIGN_SPOT', ['spot_1', 'spot_2'], 'LISTING');
    expect([...marks.entries()]).toEqual([['spot_2', 'rev_9']]);
  });
});
