import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q5/Q19/Q104/Q112/Q137) — reviews of spots and of agents.
 *
 * What is pinned, decision by decision:
 *
 *   104  only the campaign's advertiser reviews a spot, only once its booking
 *        there COMPLETED, once per campaign spot; the listing's stars are
 *        recomputed on every write and the publisher is told; ops may hide
 *        with a reason and the hidden review leaves the average.
 *   112  a publisher rates the agent on an order from the on-site OTP onward
 *        (PENDING_APPROVAL or COMPLETED, with an agent on it), once per
 *        publisher–agent pair for ever; the eligibility read says why not.
 */

const { repository, campaigns, listings, orders, agents, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findByAnchor: vi.fn(),
    create: vi.fn(),
    publisherHasRatedAgent: vi.fn(),
    aggregate: vi.fn(),
    listPublished: vi.fn(),
    listForAdmin: vi.fn(),
    setStatus: vi.fn(),
    recentForAgent: vi.fn(),
  },
  campaigns: { assertMayAct: vi.fn(), findCampaignSpotForReview: vi.fn() },
  listings: { getListingWithPublisher: vi.fn(), setListingRatingSnapshot: vi.fn() },
  orders: { getOrderSummary: vi.fn() },
  agents: { setAgentReviewSnapshot: vi.fn() },
  notifications: { createNotification: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((before: object, after: object, fields: string[]) => ({ [fields[0]!]: { before: (before as never)[fields[0]!], after: (after as never)[fields[0]!] } })) },
}));

vi.mock('../prisma-reviews.repository', () => ({ prismaReviewsRepository: repository }));
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../listings', () => listings);
vi.mock('../../orders', () => orders);
vi.mock('../../agents', () => agents);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);

import { hideReview, listReviews, listingReviews, rateAgent, rateAgentEligibility, reviewSpot, unhideReview } from '../reviews.service';
import { rateSchema } from '../reviews.schema';

const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };

const review = (over: Record<string, unknown> = {}) => ({
  id: 'rev_1',
  subjectType: 'LISTING',
  subjectId: 'lst_1',
  authorUserId: 'usr_adv',
  authorPublisherId: null,
  authorAdvertiserId: 'adv_1',
  anchorKind: 'CAMPAIGN_SPOT',
  anchorId: 'spot_1',
  rating: 5,
  note: 'Great footfall',
  status: 'PUBLISHED',
  hiddenReason: null,
  hiddenById: null,
  createdAt: new Date('2026-09-10T10:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  campaigns.findCampaignSpotForReview.mockResolvedValue({
    campaign: { id: 'cmp_1', reference: 'ADX-CMP-2026-1', name: 'Monsoon', advertiserId: 'adv_1', agentId: null, status: 'COMPLETED' },
    spot: { id: 'spot_1', listingId: 'lst_1', status: 'COMPLETED', title: 'MG Road' },
  });
  campaigns.assertMayAct.mockImplementation(() => undefined);
  repository.findByAnchor.mockResolvedValue(null);
  repository.create.mockImplementation(async (data: object) => review(data as never));
  repository.aggregate.mockResolvedValue({ avg: '4.50', count: 2 });
  listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', title: 'MG Road', publisher: { id: 'pub_1', userId: 'usr_pub' } });
  listings.setListingRatingSnapshot.mockResolvedValue(undefined);
  agents.setAgentReviewSnapshot.mockResolvedValue(undefined);
  notifications.createNotification.mockResolvedValue(undefined);
  audit.logActivity.mockResolvedValue(undefined);
  orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'COMPLETED', agentId: 'agt_1', listingId: 'lst_1' });
  repository.publisherHasRatedAgent.mockResolvedValue(false);
});

describe('the body', () => {
  it('is a whole star from one to five and an optional note', () => {
    expect(rateSchema.parse({ rating: 4 })).toEqual({ rating: 4 });
    expect(rateSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(rateSchema.safeParse({ rating: 4.5 }).success).toBe(false);
    expect(rateSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(rateSchema.parse({ rating: 3, note: '  fine  ' }).note).toBe('fine');
  });
});

describe('reviewing a spot (Q104)', () => {
  it('writes one review anchored on the campaign spot, recomputes the stars and tells the publisher', async () => {
    const written = await reviewSpot('cmp_1', 'spot_1', { rating: 5, note: 'Great footfall' }, advertiser);
    expect(campaigns.assertMayAct).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1' }), advertiser);
    expect(repository.create).toHaveBeenCalledWith({
      subjectType: 'LISTING',
      subjectId: 'lst_1',
      authorUserId: 'usr_adv',
      authorPublisherId: null,
      authorAdvertiserId: 'adv_1',
      anchorKind: 'CAMPAIGN_SPOT',
      anchorId: 'spot_1',
      rating: 5,
      note: 'Great footfall',
    });
    expect(repository.aggregate).toHaveBeenCalledWith('LISTING', 'lst_1');
    expect(listings.setListingRatingSnapshot).toHaveBeenCalledWith('lst_1', { ratingAvg: '4.50', reviewCount: 2 });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', type: 'BOOKING', relatedId: 'lst_1' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_adv', 'LISTING_REVIEWED', expect.objectContaining({ targetType: 'Listing', targetId: 'lst_1' }));
    expect(written.id).toBe('rev_1');
  });

  it('is only for a spot whose booking completed', async () => {
    campaigns.findCampaignSpotForReview.mockResolvedValue({
      campaign: { id: 'cmp_1', reference: 'r', name: 'n', advertiserId: 'adv_1', agentId: null, status: 'LIVE' },
      spot: { id: 'spot_1', listingId: 'lst_1', status: 'LIVE', title: 'MG Road' },
    });
    await expect(reviewSpot('cmp_1', 'spot_1', { rating: 5 }, advertiser)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('is once per spot — a second attempt is 409 REVIEW_EXISTS', async () => {
    repository.findByAnchor.mockResolvedValue(review());
    await expect(reviewSpot('cmp_1', 'spot_1', { rating: 4 }, advertiser)).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_EXISTS' });
  });

  it('is the advertiser’s to write, not ops’ and not the agent’s', async () => {
    await expect(reviewSpot('cmp_1', 'spot_1', { rating: 4 }, { userId: 'usr_ops', isAdmin: true, advertiserId: null, agentId: null })).rejects.toMatchObject({ statusCode: 403 });
    await expect(reviewSpot('cmp_1', 'spot_1', { rating: 4 }, { userId: 'usr_agt', isAdmin: false, advertiserId: null, agentId: 'agt_9' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(reviewSpot('cmp_x', 'spot_1', { rating: 4 }, advertiser)).resolves.toBeDefined();
    campaigns.findCampaignSpotForReview.mockResolvedValue(null);
    await expect(reviewSpot('cmp_x', 'spot_1', { rating: 4 }, advertiser)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the public page lists PUBLISHED reviews only, as a list page', async () => {
    repository.listPublished.mockResolvedValue({ items: [review(), review({ id: 'rev_2', rating: 3, note: null })], total: 2 });
    const page = await listingReviews('lst_1', { page: 1, pageSize: 20 });
    expect(repository.listPublished).toHaveBeenCalledWith('LISTING', 'lst_1', 1, 20);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(page.items[0]).toEqual({ id: 'rev_1', rating: 5, note: 'Great footfall', createdAt: review().createdAt });
    expect(JSON.stringify(page)).not.toContain('usr_adv');
  });
});

describe('rating the agent (Q112)', () => {
  const publisherUser = 'usr_pub';

  it('writes one review anchored on the order and recomputes the agent snapshot', async () => {
    repository.aggregate.mockResolvedValue({ avg: '3.67', count: 3 });
    const written = await rateAgent('ord_1', { rating: 3, note: 'Late' }, publisherUser);
    expect(repository.create).toHaveBeenCalledWith({
      subjectType: 'AGENT',
      subjectId: 'agt_1',
      authorUserId: 'usr_pub',
      authorPublisherId: 'pub_1',
      authorAdvertiserId: null,
      anchorKind: 'ORDER',
      anchorId: 'ord_1',
      rating: 3,
      note: 'Late',
    });
    expect(agents.setAgentReviewSnapshot).toHaveBeenCalledWith('agt_1', { reviewAvg: '3.67', reviewCount: 3 });
    expect(written.subjectType).toBe('AGENT');
  });

  it('is asked from the on-site OTP onward: PENDING_APPROVAL or COMPLETED, with an agent', async () => {
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'PENDING_APPROVAL', agentId: 'agt_1', listingId: 'lst_1' });
    await expect(rateAgent('ord_1', { rating: 5 }, publisherUser)).resolves.toBeDefined();
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'IN_PROGRESS', agentId: 'agt_1', listingId: 'lst_1' });
    await expect(rateAgent('ord_1', { rating: 5 }, publisherUser)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'COMPLETED', agentId: null, listingId: 'lst_1' });
    await expect(rateAgent('ord_1', { rating: 5 }, publisherUser)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('is the publisher who owns the listing, nobody else', async () => {
    await expect(rateAgent('ord_1', { rating: 5 }, 'usr_other')).rejects.toMatchObject({ statusCode: 403 });
    orders.getOrderSummary.mockResolvedValue(null);
    await expect(rateAgent('ord_x', { rating: 5 }, publisherUser)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('is once per publisher–agent pair for ever — 409 REVIEW_EXISTS on the pair, and on the order', async () => {
    repository.publisherHasRatedAgent.mockResolvedValue(true);
    await expect(rateAgent('ord_1', { rating: 5 }, publisherUser)).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_EXISTS' });
    expect(repository.publisherHasRatedAgent).toHaveBeenCalledWith('pub_1', 'agt_1');
    repository.publisherHasRatedAgent.mockResolvedValue(false);
    repository.findByAnchor.mockResolvedValue(review({ subjectType: 'AGENT' }));
    await expect(rateAgent('ord_1', { rating: 5 }, publisherUser)).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_EXISTS' });
  });

  it('the eligibility read says whether to ask, and why not', async () => {
    await expect(rateAgentEligibility('ord_1', publisherUser)).resolves.toEqual({ askable: true, reason: null });
    repository.publisherHasRatedAgent.mockResolvedValue(true);
    await expect(rateAgentEligibility('ord_1', publisherUser)).resolves.toEqual({ askable: false, reason: 'ALREADY_RATED' });
    repository.publisherHasRatedAgent.mockResolvedValue(false);
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'SLOT_CONFIRMED', agentId: 'agt_1', listingId: 'lst_1' });
    await expect(rateAgentEligibility('ord_1', publisherUser)).resolves.toEqual({ askable: false, reason: 'NOT_YET' });
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'COMPLETED', agentId: null, listingId: 'lst_1' });
    await expect(rateAgentEligibility('ord_1', publisherUser)).resolves.toEqual({ askable: false, reason: 'NO_AGENT' });
    await expect(rateAgentEligibility('ord_1', 'usr_other')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('moderation (Q104: ops may hide with a reason)', () => {
  it('hides with a reason, recomputes the subject’s stars without it, and audits the status diff', async () => {
    repository.findById.mockResolvedValue(review());
    repository.setStatus.mockResolvedValue(review({ status: 'HIDDEN', hiddenReason: 'Names a person', hiddenById: 'usr_ops' }));
    repository.aggregate.mockResolvedValue({ avg: null, count: 0 });
    const hidden = await hideReview('rev_1', 'Names a person', 'usr_ops');
    expect(repository.setStatus).toHaveBeenCalledWith('rev_1', { status: 'HIDDEN', hiddenReason: 'Names a person', hiddenById: 'usr_ops' });
    expect(listings.setListingRatingSnapshot).toHaveBeenCalledWith('lst_1', { ratingAvg: null, reviewCount: 0 });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_ops',
      'REVIEW_HIDDEN',
      expect.objectContaining({ targetType: 'Review', targetId: 'rev_1', diff: { status: { before: 'PUBLISHED', after: 'HIDDEN' } } }),
    );
    expect(hidden.status).toBe('HIDDEN');
  });

  it('refuses to hide twice, and unhide puts it back into the average', async () => {
    repository.findById.mockResolvedValue(review({ status: 'HIDDEN', hiddenReason: 'x' }));
    await expect(hideReview('rev_1', 'again', 'usr_ops')).rejects.toMatchObject({ statusCode: 409 });
    repository.setStatus.mockResolvedValue(review());
    await unhideReview('rev_1', 'usr_ops');
    expect(repository.setStatus).toHaveBeenCalledWith('rev_1', { status: 'PUBLISHED', hiddenReason: null, hiddenById: null });
    expect(listings.setListingRatingSnapshot).toHaveBeenCalledWith('lst_1', { ratingAvg: '4.50', reviewCount: 2 });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_ops', 'REVIEW_UNHIDDEN', expect.objectContaining({ targetId: 'rev_1' }));
  });

  it('an agent review that is hidden recomputes the agent snapshot instead', async () => {
    repository.findById.mockResolvedValue(review({ subjectType: 'AGENT', subjectId: 'agt_1' }));
    repository.setStatus.mockResolvedValue(review({ subjectType: 'AGENT', subjectId: 'agt_1', status: 'HIDDEN' }));
    await hideReview('rev_1', 'Abusive', 'usr_ops');
    expect(agents.setAgentReviewSnapshot).toHaveBeenCalledWith('agt_1', { reviewAvg: '4.50', reviewCount: 2 });
    expect(listings.setListingRatingSnapshot).not.toHaveBeenCalled();
  });

  it('the desk list is a list page with a status histogram', async () => {
    repository.listForAdmin.mockResolvedValue({ items: [review()], total: 1, counts: { PUBLISHED: 1, HIDDEN: 0 } });
    const page = await listReviews({ subjectType: 'LISTING', subjectId: 'lst_1', page: 1, pageSize: 20, sort: 'NEWEST' });
    expect(page).toMatchObject({ total: 1, counts: { PUBLISHED: 1, HIDDEN: 0 } });
    expect(page.items[0]).toMatchObject({ id: 'rev_1', authorUserId: 'usr_adv' });
  });
});
