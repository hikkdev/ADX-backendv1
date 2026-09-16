import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P-B — the publisher's detail card (`GET /publishers/:id/summary`) and the
 * agent on the party read.
 *
 * Pinned: the month window is the Indian calendar month `now` falls in
 * (accruals by their UTC date, payouts and bookings by the IST instant);
 * every money figure is a decimal string; a publisher with no wallet, no
 * subscription, no reviews and no agent answers zeros and nulls rather than
 * blowing up; the feed is merged newest first and capped; the detail read
 * answers `agent { id, displayId, name } | null`. The subscription and the
 * visits come through the summary port (`revenue` and `visits` both reach
 * this module), so the test registers the two reads the way bootstrap does.
 */

const { repository, summaryRepository, payouts, wallets, revenue, visits, agents, kyc } = vi.hoisted(() => ({
  repository: { findById: vi.fn() },
  summaryRepository: { listingsOf: vi.fn(), bookingFacts: vi.fn(), feedOf: vi.fn() },
  payouts: { earningsSummary: vi.fn(), listAccrualsForPeriod: vi.fn(), paidWithdrawalTotal: vi.fn(), listWithdrawals: vi.fn() },
  wallets: { findWalletFor: vi.fn(), snapshot: vi.fn() },
  revenue: { runningSubscriptionForPublisher: vi.fn() },
  visits: { visitsForPublisher: vi.fn() },
  agents: { findAgentProfile: vi.fn(), requireAgentProfile: vi.fn() },
  kyc: { listDocumentReviews: vi.fn(async (): Promise<unknown[]> => []) },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../book/prisma-publisher-summary.repository', () => ({ prismaPublisherSummaryRepository: summaryRepository }));
vi.mock('../../payouts', () => payouts);
vi.mock('../../wallets', () => wallets);
vi.mock('../../agents', () => agents);
vi.mock('../../kyc', () => ({
  listDocumentReviews: kyc.listDocumentReviews,
  flaggedDocuments: vi.fn(),
  clearDocumentReviews: vi.fn(),
  flagDocuments: vi.fn(),
  recordDocumentReview: vi.fn(),
  hasSubmittedLiveness: vi.fn(),
  livenessStateFor: vi.fn(),
  maskPan: vi.fn(),
  trimDigioPayload: vi.fn(),
  kycUserLabels: vi.fn(async () => new Map()),
}));

import { Decimal } from '../../../shared/money';
import { publisherSummary, publisherMonthWindows } from '../book/publisher-summary.service';
import { registerPublisherSummaryPort } from '../book/summary.port';
import { getOwnedPublisher } from '../publishers.service';
import { toAgentLabel } from '../publishers.repository';

// 15 Sep 2026, 02:00 IST — 14 Sep 20:30Z. The Indian month is September.
const NOW = new Date('2026-09-14T20:30:00.000Z');
const at = (iso: string) => new Date(iso);

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  displayId: 'PUB-0101-2601',
  name: 'Suraj Kumar Prints',
  mobile: '+919800000002',
  city: 'Bengaluru',
  kycStatus: 'VERIFIED',
  onboardingStatus: 'ONBOARDING_COMPLETE',
  agentId: 'agt_1',
  agent: { id: 'agt_1', displayId: 'AGT-0001', name: 'Ravi Menon' },
  kyc: null,
  listings: [{ id: 'lst_1', _count: { orders: 1 } }],
  user: { closedAt: null, closeReason: null },
  createdAt: at('2026-05-01T00:00:00.000Z'),
  ...over,
});

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0001',
  title: 'Koramangala wall',
  category: 'OUTDOOR',
  city: 'Bengaluru',
  status: 'ACTIVE',
  publishedAt: at('2026-08-20T06:00:00.000Z'),
  ratePerDay: new Decimal('450.00'),
  ratingAvg: new Decimal('4.50'),
  reviewCount: 2,
  occupied: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // `revenue` and `visits` both reach `publishers`, so the card reads them through the port bootstrap fills.
  registerPublisherSummaryPort({ runningSubscription: revenue.runningSubscriptionForPublisher, visits: visits.visitsForPublisher });
  repository.findById.mockResolvedValue(publisher());
  summaryRepository.listingsOf.mockResolvedValue([
    listing(),
    listing({ id: 'lst_2', displayId: 'LST-0002', title: 'Indiranagar lobby', status: 'PENDING_REVIEW', publishedAt: null, ratingAvg: new Decimal('3.00'), reviewCount: 1, occupied: false }),
  ]);
  summaryRepository.bookingFacts.mockResolvedValue({ lifetime: 12, thisMonth: 3 });
  summaryRepository.feedOf.mockResolvedValue([]);
  payouts.earningsSummary.mockResolvedValue({ netEarned: '45200.00', grossEarned: '50000.00' });
  payouts.listAccrualsForPeriod.mockResolvedValue([{ net: new Decimal('1200.50') }, { net: new Decimal('800.00') }]);
  payouts.paidWithdrawalTotal.mockImplementation(async (filter: { paidFrom?: Date }) => (filter.paidFrom ? { total: '5000.00', count: 1 } : { total: '30000.00', count: 4 }));
  payouts.listWithdrawals.mockResolvedValue([]);
  wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
  wallets.snapshot.mockResolvedValue({ walletId: 'wal_1', balance: '15200.00', withdrawable: '14000.00' });
  revenue.runningSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'PLUS', startsAt: at('2026-07-01T00:00:00.000Z'), endsAt: at('2026-12-31T18:30:00.000Z') });
  visits.visitsForPublisher.mockResolvedValue([]);
});

describe('the month windows', () => {
  it('are the Indian calendar month now falls in — accruals by UTC date, instants by IST midnight', () => {
    const { accruals, instants } = publisherMonthWindows(NOW);
    expect(accruals).toEqual({ start: at('2026-09-01T00:00:00.000Z'), end: at('2026-10-01T00:00:00.000Z') });
    expect(instants).toEqual({ start: at('2026-08-31T18:30:00.000Z'), end: at('2026-09-30T18:30:00.000Z') });
  });
});

describe('the summary metrics', () => {
  it('reads every figure through the owning modules and prints money as decimal strings', async () => {
    const summary = await publisherSummary('pub_1', 'usr_admin', NOW);

    expect(summary.publisher).toMatchObject({ id: 'pub_1', agent: { id: 'agt_1', displayId: 'AGT-0001', name: 'Ravi Menon' }, openOrders: 1 });
    expect(summary.metrics).toEqual({
      earningsThisMonth: '2000.50',
      earningsLifetime: '45200.00',
      payoutsReleased: { lifetime: '30000.00', thisMonth: '5000.00' },
      walletBalance: '15200.00',
      withdrawable: '14000.00',
      listingsTotal: 2,
      listingsLive: 1,
      bookingsThisMonth: 3,
      bookingsLifetime: 12,
      // (4.5 × 2 + 3.0 × 1) / 3, weighted by the reviews behind each spot.
      ratingAvg: '4.00',
      subscription: { tier: 'PLUS', endsAt: '2026-12-31T18:30:00.000Z' },
    });

    // The accruals of the month, by their UTC date; the payouts and the bookings by the IST instant.
    expect(payouts.listAccrualsForPeriod).toHaveBeenCalledWith('pub_1', at('2026-09-01T00:00:00.000Z'), at('2026-10-01T00:00:00.000Z'));
    expect(payouts.paidWithdrawalTotal).toHaveBeenCalledWith({ publisherId: 'pub_1' });
    expect(payouts.paidWithdrawalTotal).toHaveBeenCalledWith({ publisherId: 'pub_1', paidFrom: at('2026-08-31T18:30:00.000Z'), paidTo: at('2026-09-30T18:30:00.000Z') });
    expect(summaryRepository.bookingFacts).toHaveBeenCalledWith('pub_1', { start: at('2026-08-31T18:30:00.000Z'), end: at('2026-09-30T18:30:00.000Z') });
    expect(wallets.findWalletFor).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_1' });
    expect(wallets.snapshot).toHaveBeenCalledWith('wal_1', NOW);
    expect(revenue.runningSubscriptionForPublisher).toHaveBeenCalledWith('pub_1', NOW);
  });

  it('lists the spots with their live state', async () => {
    const summary = await publisherSummary('pub_1', 'usr_admin', NOW);
    expect(summary.listings).toEqual([
      { id: 'lst_1', displayId: 'LST-0001', title: 'Koramangala wall', category: 'OUTDOOR', city: 'Bengaluru', status: 'ACTIVE', live: true, occupied: true, publishedAt: '2026-08-20T06:00:00.000Z', ratePerDay: '450.00', ratingAvg: '4.50', reviewCount: 2 },
      { id: 'lst_2', displayId: 'LST-0002', title: 'Indiranagar lobby', category: 'OUTDOOR', city: 'Bengaluru', status: 'PENDING_REVIEW', live: false, occupied: false, publishedAt: null, ratePerDay: '450.00', ratingAvg: '3.00', reviewCount: 1 },
    ]);
  });

  it('answers zeros and nulls for a publisher with no wallet, no earnings, no subscription, no reviews and no agent', async () => {
    repository.findById.mockResolvedValue(publisher({ agentId: null, agent: null, listings: [] }));
    summaryRepository.listingsOf.mockResolvedValue([listing({ ratingAvg: null, reviewCount: 0 })]);
    summaryRepository.bookingFacts.mockResolvedValue({ lifetime: 0, thisMonth: 0 });
    payouts.earningsSummary.mockResolvedValue({ netEarned: '0.00' });
    payouts.listAccrualsForPeriod.mockResolvedValue([]);
    payouts.paidWithdrawalTotal.mockResolvedValue({ total: '0.00', count: 0 });
    wallets.findWalletFor.mockResolvedValue(null);
    revenue.runningSubscriptionForPublisher.mockResolvedValue(null);

    const summary = await publisherSummary('pub_1', 'usr_admin', NOW);
    expect(summary.publisher.agent).toBeNull();
    expect(summary.metrics).toMatchObject({
      earningsThisMonth: '0.00',
      earningsLifetime: '0.00',
      payoutsReleased: { lifetime: '0.00', thisMonth: '0.00' },
      walletBalance: '0.00',
      withdrawable: '0.00',
      ratingAvg: null,
      subscription: null,
    });
    expect(wallets.snapshot).not.toHaveBeenCalled();
  });

  it('is 404 for a publisher that does not exist', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(publisherSummary('pub_missing', 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the activity feed', () => {
  it('merges the action log, field visits, listings gone live, bookings authorised and payouts released, newest first', async () => {
    summaryRepository.feedOf.mockResolvedValue([
      { kind: 'ACTIVITY', at: at('2026-09-10T08:00:00.000Z'), title: 'Checked in', detail: 'Renewal talk' },
      { kind: 'LISTING_LIVE', at: at('2026-08-20T06:00:00.000Z'), title: 'Listing went live: Koramangala wall', detail: null },
      { kind: 'BOOKING_AUTHORISED', at: at('2026-09-12T09:00:00.000Z'), title: 'Booking authorised: Diwali drive', detail: 'Koramangala wall' },
    ]);
    visits.visitsForPublisher.mockResolvedValue([
      { id: 'vst_1', kind: 'RENEWAL', status: 'COMPLETED', businessName: 'Suraj Kumar Prints', locality: 'Koramangala', completedAt: '2026-09-11T10:00:00.000Z', scheduledFor: '2026-09-11T09:00:00.000Z' },
      { id: 'vst_2', kind: 'ONBOARDING', status: 'SCHEDULED', businessName: 'Suraj Kumar Prints', locality: null, completedAt: null, scheduledFor: '2026-09-16T09:00:00.000Z' },
    ]);
    payouts.listWithdrawals.mockResolvedValue([
      { id: 'wdr_1', reference: 'WDR-1', status: 'PAID', netAmount: new Decimal('5000.00'), paidAt: at('2026-09-13T12:00:00.000Z'), requestedAt: at('2026-09-12T00:00:00.000Z') },
    ]);

    const summary = await publisherSummary('pub_1', 'usr_admin', NOW);
    expect(summary.activity.map((event) => [event.kind, event.at])).toEqual([
      ['FIELD_VISIT', '2026-09-16T09:00:00.000Z'],
      ['PAYOUT_RELEASED', '2026-09-13T12:00:00.000Z'],
      ['BOOKING_AUTHORISED', '2026-09-12T09:00:00.000Z'],
      ['FIELD_VISIT', '2026-09-11T10:00:00.000Z'],
      ['ACTIVITY', '2026-09-10T08:00:00.000Z'],
      ['LISTING_LIVE', '2026-08-20T06:00:00.000Z'],
    ]);
    expect(summary.activity[1]).toEqual({ kind: 'PAYOUT_RELEASED', at: '2026-09-13T12:00:00.000Z', title: 'Payout released: 5000.00', detail: 'WDR-1' });
    expect(summary.activity[0]).toMatchObject({ title: 'Onboarding visit at Suraj Kumar Prints', detail: 'Scheduled' });
    expect(summary.activity[3]).toMatchObject({ title: 'Renewal visit at Suraj Kumar Prints Koramangala', detail: null });
    // Each source is asked for no more than the cap, and only PAID lines of this publisher.
    expect(payouts.listWithdrawals).toHaveBeenCalledWith({ publisherId: 'pub_1', status: ['PAID'], limit: 30 });
    expect(visits.visitsForPublisher).toHaveBeenCalledWith('pub_1', 30);
    expect(summaryRepository.feedOf).toHaveBeenCalledWith('pub_1', 30);
  });

  it('is capped at thirty events, like the advertiser card', async () => {
    summaryRepository.feedOf.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ kind: 'ACTIVITY', at: new Date(Date.UTC(2026, 7, 1 + (i % 28), i)), title: `Note ${i}`, detail: null })),
    );
    const summary = await publisherSummary('pub_1', 'usr_admin', NOW);
    expect(summary.activity).toHaveLength(30);
    for (let i = 1; i < summary.activity.length; i += 1) {
      expect(summary.activity[i - 1]!.at >= summary.activity[i]!.at).toBe(true);
    }
  });
});

describe('the detail read', () => {
  it('answers the onboarding agent by name, and null when nobody brought them', async () => {
    const view = await getOwnedPublisher('pub_1', 'usr_admin', { isAdmin: true });
    expect(view.agent).toEqual({ id: 'agt_1', displayId: 'AGT-0001', name: 'Ravi Menon' });

    repository.findById.mockResolvedValue(publisher({ agentId: null, agent: null }));
    const alone = await getOwnedPublisher('pub_1', 'usr_admin', { isAdmin: true });
    expect(alone.agent).toBeNull();
  });

  it('maps the include the way the KYC queue joins it', () => {
    expect(toAgentLabel({ id: 'agt_1', displayId: 'AGT-0001', user: { name: 'Ravi Menon' } })).toEqual({ id: 'agt_1', displayId: 'AGT-0001', name: 'Ravi Menon' });
    expect(toAgentLabel({ id: 'agt_2', displayId: null, user: { name: null } })).toEqual({ id: 'agt_2', displayId: null, name: null });
    expect(toAgentLabel(null)).toBeNull();
    expect(toAgentLabel(undefined)).toBeNull();
  });
});
