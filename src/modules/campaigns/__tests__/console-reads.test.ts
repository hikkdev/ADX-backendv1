import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';
import { gateFacts } from './gate-facts.fixture';

/**
 * The Campaigns lot (2 Oct 2026): the console's reads of campaigns —
 * the list's extra columns and filters, the launch queue, the reminder to
 * pay, the campaign page's banner and Performance card, the cancel's
 * impact, and the landing-page list's advertiser and numbers.
 */

const { repository, notifications, audit, pricing, settings } = vi.hoisted(() => ({
  repository: {
    listCampaignsPage: vi.fn(),
    campaignGateFacts: vi.fn(),
    performanceTotals: vi.fn(),
    gateCandidates: vi.fn(),
    listLandingPages: vi.fn(),
    eventTotalsByDay: vi.fn(),
  },
  notifications: { createNotification: vi.fn(async () => ({})) },
  audit: { logActivity: vi.fn(async () => undefined), findActivityRows: vi.fn(async () => [] as { createdAt: Date }[]) },
  pricing: {
    cityKeyFor: vi.fn(async (name: string) => (name.toLowerCase() === 'bengaluru' ? { cityId: 'city_blr', slug: 'bengaluru' } : null)),
    assertCityAllows: vi.fn(),
  },
  settings: { getPlatformSettings: vi.fn(async () => ({ booking: { reservationFee: { retainPct: 10 } } })) },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../notifications', () => notifications);
vi.mock('../../pricing', () => pricing);
vi.mock('../../app-config', () => settings);
vi.mock('../../listings', () => ({ getContentRules: vi.fn(), getListingWithPublisher: vi.fn(), audienceForSpots: vi.fn(), currentPeriod: vi.fn() }));
vi.mock('../../orders', () => ({ notifyAdmins: vi.fn(), placeOrder: vi.fn(), announceOrdersPaid: vi.fn() }));
vi.mock('../../advertisers', () => ({ getAdvertiserForUser: vi.fn(), assertCanBook: vi.fn(), holdForCampaign: vi.fn(), releaseCampaignHold: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../users', () => ({ listAdminUserIds: vi.fn(async () => []) }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => false),
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../revenue', () => ({ quote: vi.fn() }));
vi.mock('../../agreements', () => ({ insertionOrderSigning: vi.fn(), transactionAcceptance: vi.fn() }));
vi.mock('../../promo-codes', () => ({ countRedemptions: vi.fn(), discountFor: vi.fn(), findPromoByCode: vi.fn(), promoProblem: vi.fn(), recordRedemption: vi.fn(), releaseRedemption: vi.fn(), applyPromoCodeSchema: {} }));
vi.mock('../../ai', () => ({ assertLandingPageQuota: vi.fn(), recordLandingPageGeneration: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
  findActivityRows: audit.findActivityRows,
}));

import { listCampaignsPage } from '../campaigns.service';
import { launchQueueQuerySchema, listCampaignsQuerySchema, landingPageListQuerySchema } from '../campaigns.schema';
import { consoleDetailExtras, launchQueue, launchQueueSummary, listLandingPagesForConsole, remindPayment } from '../console.service';
import { campaignPerformance } from '../analytics.service';
import { cancelImpact } from '../checkout.service';

const ADMIN = { userId: 'usr_admin', isAdmin: true, advertiserId: null, agentId: null };
const ADVERTISER = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const NOW = new Date('2026-10-02T10:00:00Z');

const listRow = (over: Record<string, unknown> = {}) => ({
  id: 'cmp_1',
  reference: 'ADX-CMP-2026-482913',
  name: 'Diwali push',
  status: 'SCHEDULED',
  goal: 'BRAND_AWARENESS',
  brandName: 'Anita',
  city: 'Bengaluru',
  budget: new Decimal('60000'),
  total: new Decimal('59000'),
  startDate: new Date('2026-10-12T00:00:00Z'),
  endDate: new Date('2026-10-25T00:00:00Z'),
  spotCount: 2,
  spendToDate: new Decimal(0),
  advertiser: { id: 'adv_1', displayId: 'ADV-1909-2601', name: 'Anita Foods' },
  createdAt: new Date('2026-09-20T10:00:00Z'),
  updatedAt: new Date('2026-09-25T10:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.listCampaignsPage.mockResolvedValue({ items: [listRow()], total: 1, counts: { SCHEDULED: 1 } });
  repository.campaignGateFacts.mockResolvedValue([gateFacts()]);
  repository.performanceTotals.mockResolvedValue({ cmp_1: { scans: 40, views: 22, ctaClicks: 9, enquiries: 3 } });
  repository.gateCandidates.mockResolvedValue([]);
  audit.findActivityRows.mockResolvedValue([]);
});

/* ── The list ─────────────────────────────────────────────────────────── */

describe('GET /campaigns — the console columns', () => {
  it('gives ADX the advertiser as placedBy, what it waits on, its spots, engagement, what was paid and the days left', async () => {
    repository.campaignGateFacts.mockResolvedValue([
      gateFacts({ advertiser: { ...gateFacts().advertiser, kycStatus: 'PENDING' }, spots: [{ id: 's1', status: 'BOOKED', order: null }, { id: 's2', status: 'CANCELLED', order: null }] }),
    ]);
    const page = await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({}), NOW);
    expect(page.items[0]).toMatchObject({
      id: 'cmp_1',
      reference: 'ADX-CMP-2026-482913',
      advertiser: { userId: 'usr_adv', name: 'Anita Rao', displayId: 'ADX-0001', business: { id: 'adv_1', name: 'Anita Foods', displayId: 'ADV-1909-2601' } },
      waitingOn: ['KYC'],
      spotsLive: 0,
      spotsTotal: 1,
      performance: { scans: 40, views: 22, ctaClicks: 9, enquiries: 3 },
      paidAmount: '59000.00',
      daysLeft: null,
    });
    // One read of each for the whole page.
    expect(repository.campaignGateFacts).toHaveBeenCalledTimes(1);
    expect(repository.campaignGateFacts).toHaveBeenCalledWith(['cmp_1']);
    expect(repository.performanceTotals).toHaveBeenCalledWith(['cmp_1']);
  });

  it('carries the landing page’s narrow summary — the detail’s — from the same read, or null', async () => {
    repository.listCampaignsPage.mockResolvedValue({ items: [listRow(), listRow({ id: 'cmp_2' })], total: 2, counts: {} });
    repository.campaignGateFacts.mockResolvedValue([
      gateFacts({ landingPage: { id: 'lp_1', slug: 'anita-diwali', status: 'PUBLISHED', publishedAt: new Date('2026-09-28T10:00:00Z') } }),
      gateFacts({ id: 'cmp_2' }),
    ]);
    const page = await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({}), NOW);
    expect(page.items[0]).toMatchObject({ landingPage: { id: 'lp_1', slug: 'anita-diwali', status: 'PUBLISHED', url: '/p/anita-diwali', publishedAt: new Date('2026-09-28T10:00:00Z') } });
    expect(page.items[1]).toMatchObject({ landingPage: null });
    // No read per row: the summary rides on the page's one gate-facts read.
    expect(repository.campaignGateFacts).toHaveBeenCalledTimes(1);
  });

  it('leaves a party’s rows exactly as the apps read them', async () => {
    const page = await listCampaignsPage(ADVERTISER, listCampaignsQuerySchema.parse({}), NOW);
    expect(page.items[0]).toEqual(listRow());
    expect(repository.campaignGateFacts).not.toHaveBeenCalled();
  });

  it('passes the filter bar through: city by its key, the flight as UTC days, goals', async () => {
    await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({ city: 'Bengaluru', from: '2026-10-01', to: '2026-10-31', goal: 'BRAND_AWARENESS,LOCAL_FOOTFALL', q: 'ADV-1909' }), NOW);
    expect(repository.listCampaignsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        city: 'Bengaluru',
        cityId: 'city_blr',
        from: new Date('2026-10-01T00:00:00.000Z'),
        to: new Date('2026-11-01T00:00:00.000Z'),
        goal: ['BRAND_AWARENESS', 'LOCAL_FOOTFALL'],
        q: 'ADV-1909',
      }),
    );
  });

  it('refuses a flight that ends before it starts, and an unknown gate', async () => {
    await expect(listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({ from: '2026-10-10', to: '2026-10-01' }), NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(listCampaignsQuerySchema.safeParse({ waitingOn: 'KYC,ARTWORKS' }).success).toBe(false);
    expect(listCampaignsQuerySchema.parse({ waitingOn: 'KYC, ARTWORK' }).waitingOn).toEqual(['KYC', 'ARTWORK']);
  });

  it('resolves `waitingOn` to the ids the derivation keeps — a superseded artwork does not count', async () => {
    repository.gateCandidates.mockResolvedValue([
      gateFacts({ id: 'cmp_kyc', advertiser: { ...gateFacts().advertiser, kycStatus: 'PENDING' } }),
      gateFacts({
        id: 'cmp_replaced',
        creatives: [
          { id: 'cr_1', resubmissionOfId: null, fileUrl: 'https://cdn/a.png', status: 'REJECTED', designedByAdx: false },
          { id: 'cr_2', resubmissionOfId: 'cr_1', fileUrl: 'https://cdn/b.png', status: 'APPROVED', designedByAdx: false },
        ],
      }),
      gateFacts({ id: 'cmp_art', creatives: [{ id: 'cr_3', resubmissionOfId: null, fileUrl: 'https://cdn/c.png', status: 'IN_REVIEW', designedByAdx: false }] }),
    ]);
    await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({ waitingOn: 'KYC,ARTWORK', status: 'SCHEDULED' }), NOW);
    expect(repository.gateCandidates).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['KYC', 'ARTWORK'] }), 5000);
    expect(repository.listCampaignsPage).toHaveBeenCalledWith(expect.objectContaining({ ids: ['cmp_kyc', 'cmp_art'], status: ['SCHEDULED'] }));
  });

  it('ignores `waitingOn` from a party — it is ADX’s', async () => {
    await listCampaignsPage(ADVERTISER, listCampaignsQuerySchema.parse({ waitingOn: 'KYC' }), NOW);
    expect(repository.gateCandidates).not.toHaveBeenCalled();
    expect(repository.listCampaignsPage.mock.calls[0]![0]).not.toHaveProperty('ids');
  });
});

/* ── The launch queue ─────────────────────────────────────────────────── */

describe('GET /campaigns/launch-queue', () => {
  const unverified = { ...gateFacts().advertiser, kycStatus: 'PENDING' as const };
  const queueFacts = () => [
    // Waits on KYC, paid on the 25th.
    gateFacts({ id: 'cmp_kyc', reference: 'ADX-CMP-B', advertiser: unverified }),
    // Waits on artwork and a publisher, paid on the 20th — the oldest.
    gateFacts({
      id: 'cmp_art',
      reference: 'ADX-CMP-A',
      paidAt: new Date('2026-09-20T10:00:00Z'),
      creatives: [{ id: 'cr_1', resubmissionOfId: null, fileUrl: 'https://cdn/a.png', status: 'IN_REVIEW', designedByAdx: false }],
      spots: [{ id: 'spt_9', status: 'BOOKED', order: { id: 'ord_9', status: 'PENDING_PUBLISHER' } }],
    }),
    // Reservation fee paid on the 30th; the balance and KYC outstanding.
    gateFacts({
      id: 'cmp_fee',
      reference: 'ADX-CMP-C',
      status: 'PENDING_PAYMENT',
      paidAt: null,
      reservationFeeStatus: 'PAID',
      reservationFeeAmount: new Decimal('2950') as never,
      reservationFeePaidAt: new Date('2026-09-30T10:00:00Z'),
      advertiser: unverified,
    }),
    // Paid, nothing waiting: not in the queue.
    gateFacts({ id: 'cmp_clear' }),
  ];

  it('answers paid campaigns that cannot go live, oldest-waiting first, each with its reasons and facts', async () => {
    repository.gateCandidates.mockResolvedValue(queueFacts());
    const page = await launchQueue(launchQueueQuerySchema.parse({}), NOW);
    expect(repository.gateCandidates).toHaveBeenCalledWith({ reasons: [], paidOnly: true }, 5000);
    expect(page.items.map((row) => [row.id, row.waitingOn, row.waitingDays])).toEqual([
      ['cmp_art', ['ARTWORK', 'PUBLISHER'], 12],
      ['cmp_kyc', ['KYC'], 7],
      ['cmp_fee', ['PAYMENT', 'KYC'], 2],
    ]);
    expect(page.total).toBe(3);
    expect(page.counts).toEqual({ ALL: 3, RESERVATION_FEE: 0, PAYMENT: 1, DESIGN_QUOTE: 0, KYC: 2, ARTWORK: 1, PUBLISHER: 1, AGENT: 0 });
    expect(page.items[0]).toMatchObject({
      advertiser: { business: { id: 'adv_1' } },
      waitingFacts: { ARTWORK: { creatives: [{ id: 'cr_1', status: 'IN_REVIEW', designedByAdx: false }] }, PUBLISHER: { spotIds: ['spt_9'], orderIds: ['ord_9'] } },
      waitingSince: new Date('2026-09-20T10:00:00Z'),
      paidAmount: '59000.00',
    });
    expect(page.items[1]!.waitingFacts).toEqual({ KYC: { advertiserId: 'adv_1', kycStatus: 'PENDING', accountState: 'ACTIVE' } });
    expect(page.items[2]!.waitingFacts.PAYMENT).toEqual({ amountDue: '56050.00', sentForPaymentAt: null, reservationFeePaid: true });
  });

  it('narrows to a reason without changing the counts, and pages', async () => {
    repository.gateCandidates.mockResolvedValue(queueFacts());
    const page = await launchQueue(launchQueueQuerySchema.parse({ reason: 'KYC', pageSize: '1', page: '2' }), NOW);
    expect(page.total).toBe(2);
    expect(page.items.map((row) => row.id)).toEqual(['cmp_fee']);
    expect(page.counts['ALL']).toBe(3);
    expect(page.counts['KYC']).toBe(2);
  });

  it('searches and narrows to a city by its key', async () => {
    await launchQueue(launchQueueQuerySchema.parse({ q: 'Anita', city: 'bengaluru' }), NOW);
    expect(repository.gateCandidates).toHaveBeenCalledWith({ q: 'Anita', city: 'bengaluru', cityId: 'city_blr', reasons: [], paidOnly: true }, 5000);
    expect(launchQueueQuerySchema.safeParse({ reason: 'NOPE' }).success).toBe(false);
  });

  it('is counted for the overview the same way', async () => {
    repository.gateCandidates.mockResolvedValue(queueFacts());
    expect(await launchQueueSummary({ city: 'Mumbai', cityId: null })).toEqual({
      total: 3,
      byReason: { RESERVATION_FEE: 0, PAYMENT: 1, DESIGN_QUOTE: 0, KYC: 2, ARTWORK: 1, PUBLISHER: 1, AGENT: 0 },
    });
    expect(repository.gateCandidates).toHaveBeenCalledWith({ city: 'Mumbai', cityId: null, reasons: [], paidOnly: true }, 5000);
  });
});

/* ── The campaign page ────────────────────────────────────────────────── */

describe('GET /campaigns/:id for ADX', () => {
  it('adds the Placed-by line and the waiting banner', async () => {
    repository.campaignGateFacts.mockResolvedValue([gateFacts({ advertiser: { ...gateFacts().advertiser, kycStatus: 'REJECTED' } })]);
    expect(await consoleDetailExtras('cmp_1', NOW)).toEqual({
      placedBy: { userId: 'usr_adv', name: 'Anita Rao', displayId: 'ADX-0001', business: { id: 'adv_1', name: 'Anita Foods', displayId: 'ADV-1909-2601' } },
      waitingOn: ['KYC'],
      waitingFacts: { KYC: { advertiserId: 'adv_1', kycStatus: 'REJECTED', accountState: 'ACTIVE' } },
      paidAmount: '59000.00',
      daysLeft: null,
    });
  });
});

describe('GET /campaigns/:id/performance', () => {
  const campaign = (over: Record<string, unknown> = {}) =>
    ({ id: 'cmp_1', reference: 'ADX-CMP-2026-482913', status: 'LIVE', startDate: new Date('2026-09-29T00:00:00Z'), endDate: new Date('2026-10-10T00:00:00Z'), ...over }) as never;

  it('answers the lifetime numbers and one point per flight day run, zeros filled', async () => {
    repository.eventTotalsByDay.mockResolvedValue([
      { day: '2026-09-29', type: 'SCAN', count: 5 },
      { day: '2026-09-29', type: 'VIEW', count: 3 },
      { day: '2026-10-01', type: 'CTA_CLICK', count: 2 },
      { day: '2026-10-01', type: 'FORM_SUBMIT', count: 1 },
      { day: '2026-10-01', type: 'CLICK', count: 9 },
    ]);
    const data = await campaignPerformance(campaign(), NOW);
    expect(data.lifetime).toEqual({ scans: 40, views: 22, ctaClicks: 9, enquiries: 3 });
    expect(data.series).toEqual([
      { day: '2026-09-29', scans: 5, views: 3, ctaClicks: 0, enquiries: 0 },
      { day: '2026-09-30', scans: 0, views: 0, ctaClicks: 0, enquiries: 0 },
      { day: '2026-10-01', scans: 0, views: 0, ctaClicks: 2, enquiries: 1 },
      { day: '2026-10-02', scans: 0, views: 0, ctaClicks: 0, enquiries: 0 },
    ]);
    expect(data).toMatchObject({ startDate: '2026-09-29', endDate: '2026-10-10' });
  });

  it('has no series before the flight starts, and zeros with no engagement', async () => {
    repository.performanceTotals.mockResolvedValue({});
    const data = await campaignPerformance(campaign({ status: 'SCHEDULED', startDate: new Date('2026-10-12T00:00:00Z') }), NOW);
    expect(data.series).toEqual([]);
    expect(data.lifetime).toEqual({ scans: 0, views: 0, ctaClicks: 0, enquiries: 0 });
    expect(repository.eventTotalsByDay).not.toHaveBeenCalled();
  });
});

/* ── The cancel's impact ──────────────────────────────────────────────── */

describe('GET /campaigns/:id/cancel-impact', () => {
  const spot = (over: Record<string, unknown> = {}) => ({ id: 's1', status: 'LIVE', ratePerDay: new Decimal('1000'), quantity: 1, ...over });
  const campaign = (over: Record<string, unknown> = {}) =>
    ({
      id: 'cmp_1',
      reference: 'ADX-CMP-2026-482913',
      status: 'LIVE',
      walletHoldId: 'hold_1',
      total: new Decimal('59000'),
      startDate: new Date('2026-09-29T00:00:00Z'),
      endDate: new Date('2026-10-10T00:00:00Z'),
      reservationFeeStatus: null,
      reservationFeeAmount: null,
      spots: [spot(), spot({ id: 's2', ratePerDay: new Decimal('500'), quantity: 2 }), spot({ id: 's3', status: 'CANCELLED' })],
      ...over,
    }) as never;

  it('values a live campaign’s unused days, today included, for the refund desk', async () => {
    expect(await cancelImpact(campaign(), NOW)).toEqual({
      campaignId: 'cmp_1',
      reference: 'ADX-CMP-2026-482913',
      status: 'LIVE',
      cancellable: true,
      notCancellableBecause: null,
      holdReleased: null,
      refundNeeded: true,
      refundAmount: '18000.00',
      unusedDays: 9,
      reservationFee: null,
    });
  });

  it('releases a scheduled campaign’s hold whole', async () => {
    expect(await cancelImpact(campaign({ status: 'SCHEDULED' }), NOW)).toMatchObject({ holdReleased: '59000.00', refundNeeded: false, refundAmount: '0.00', unusedDays: 0 });
  });

  it('splits a paid reservation fee the way the forfeit does, and lets a due one lapse', async () => {
    const paid = await cancelImpact(campaign({ status: 'PENDING_PAYMENT', walletHoldId: null, reservationFeeStatus: 'PAID', reservationFeeAmount: new Decimal('2950') }), NOW);
    expect(paid.reservationFee).toEqual({ status: 'PAID', fee: '2950.00', retained: '295.00', returned: '2655.00' });
    const due = await cancelImpact(campaign({ status: 'PENDING_PAYMENT', walletHoldId: null, reservationFeeStatus: 'DUE', reservationFeeAmount: new Decimal('2950') }), NOW);
    expect(due.reservationFee).toEqual({ status: 'DUE', fee: '2950.00', retained: null, returned: null });
  });

  it('says why a finished or cancelled campaign cannot be cancelled', async () => {
    expect(await cancelImpact(campaign({ status: 'COMPLETED' }), NOW)).toMatchObject({ cancellable: false, notCancellableBecause: 'COMPLETED' });
    expect(await cancelImpact(campaign({ status: 'CANCELLED' }), NOW)).toMatchObject({ cancellable: false, notCancellableBecause: 'ALREADY_CANCELLED' });
  });
});

/* ── The reminder to pay ──────────────────────────────────────────────── */

describe('POST /campaigns/:id/remind-payment', () => {
  const pending = (over: Record<string, unknown> = {}) => ({ id: 'cmp_1', reference: 'ADX-CMP-2026-482913', name: 'Diwali push', status: 'PENDING_PAYMENT', ...over }) as never;
  const awaiting = (over: Parameters<typeof gateFacts>[0] = {}) => gateFacts({ status: 'PENDING_PAYMENT', paidAt: null, ...over });

  it('tells the advertiser, audits it, and says when the next may go', async () => {
    repository.campaignGateFacts.mockResolvedValue([awaiting()]);
    const reminder = await remindPayment(pending(), 'usr_admin', NOW);
    expect(reminder).toEqual({
      campaignId: 'cmp_1',
      reference: 'ADX-CMP-2026-482913',
      about: 'PAYMENT',
      amountDue: '59000.00',
      remindedAt: NOW,
      nextAllowedAt: new Date('2026-10-03T10:00:00Z'),
    });
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_adv', type: 'BOOKING', title: 'Your campaign is waiting for payment', relatedId: 'cmp_1', relatedType: 'CAMPAIGN' }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CAMPAIGN_PAYMENT_REMINDED', expect.objectContaining({ targetType: 'Campaign', targetId: 'cmp_1', module: 'campaigns' }));
    // The clock is the audit trail: the last reminder against this campaign in the past day.
    expect(audit.findActivityRows).toHaveBeenCalledWith(
      { action: 'CAMPAIGN_PAYMENT_REMINDED', targetType: 'Campaign', targetId: 'cmp_1', from: new Date('2026-10-01T10:00:00Z') },
      { skip: 0, take: 1, sort: 'newest' },
    );
  });

  it('reminds about the reservation fee while that is what is due', async () => {
    repository.campaignGateFacts.mockResolvedValue([awaiting({ reservationFeeStatus: 'DUE', reservationFeeAmount: new Decimal('2950') as never })]);
    const reminder = await remindPayment(pending(), 'usr_admin', NOW);
    expect(reminder).toMatchObject({ about: 'RESERVATION_FEE', amountDue: '2950.00' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Your reservation fee is due' }));
  });

  it('goes out once a day per campaign (429, with when the next may go)', async () => {
    repository.campaignGateFacts.mockResolvedValue([awaiting()]);
    audit.findActivityRows.mockResolvedValue([{ createdAt: new Date('2026-10-02T04:00:00Z') }]);
    await expect(remindPayment(pending(), 'usr_admin', NOW)).rejects.toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
      details: { lastRemindedAt: new Date('2026-10-02T04:00:00Z'), nextAllowedAt: new Date('2026-10-03T04:00:00Z') },
    });
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('refuses anything not awaiting payment, an advertiser with no login, and an account that is not working', async () => {
    await expect(remindPayment(pending({ status: 'SCHEDULED' }), 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    repository.campaignGateFacts.mockResolvedValue([awaiting({ advertiser: { ...gateFacts().advertiser, userId: null, user: null } })]);
    await expect(remindPayment(pending(), 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409 });
    repository.campaignGateFacts.mockResolvedValue([awaiting({ advertiser: { ...gateFacts().advertiser, suspensionScopes: ['BLOCK_NEW'] } })]);
    await expect(remindPayment(pending(), 'usr_admin', NOW)).rejects.toMatchObject({ statusCode: 409, details: { accountState: 'SUSPENDED' } });
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});

/* ── The landing-page list ────────────────────────────────────────────── */

describe('GET /campaigns/landing-pages', () => {
  it('answers each page with its address, title, advertiser and numbers, and passes the search on', async () => {
    repository.listLandingPages.mockResolvedValue({
      items: [
        {
          id: 'lp_1',
          campaignId: 'cmp_1',
          slug: 'anita-diwali',
          status: 'PUBLISHED',
          generatedByAi: true,
          publishedAt: new Date('2026-09-28T10:00:00Z'),
          blocks: [{ type: 'hero', headline: 'Diwali at Anita’s' }],
          campaign: { id: 'cmp_1', reference: 'ADX-CMP-2026-482913', name: 'Diwali push', status: 'LIVE', advertiserId: 'adv_1', advertiser: { id: 'adv_1', name: 'Anita Foods', companyName: null } },
          advertiserRow: gateFacts().advertiser,
        },
        { id: 'lp_2', campaignId: 'cmp_2', slug: 'quiet', status: 'DRAFT', blocks: [], campaign: null, advertiserRow: null },
      ],
      total: 2,
      counts: { DRAFT: 1, PUBLISHED: 1 },
    });
    const page = await listLandingPagesForConsole(landingPageListQuerySchema.parse({ q: 'anita', status: 'PUBLISHED,DRAFT' }));
    expect(repository.listLandingPages).toHaveBeenCalledWith(expect.objectContaining({ q: 'anita', status: ['PUBLISHED', 'DRAFT'] }));
    expect(repository.performanceTotals).toHaveBeenCalledWith(['cmp_1', 'cmp_2']);
    expect(page.items[0]).toMatchObject({
      url: '/p/anita-diwali',
      heroTitle: 'Diwali at Anita’s',
      generatedByAi: true,
      advertiser: { userId: 'usr_adv', name: 'Anita Rao', business: { id: 'adv_1', name: 'Anita Foods' } },
      views: 22,
      ctaClicks: 9,
      enquiries: 3,
      campaign: { advertiser: { id: 'adv_1', name: 'Anita Foods', companyName: null } },
    });
    expect(page.items[0]).not.toHaveProperty('advertiserRow');
    expect(page.items[1]).toMatchObject({ heroTitle: null, advertiser: null, views: 0, ctaClicks: 0, enquiries: 0 });
    expect(page.counts).toEqual({ DRAFT: 1, PUBLISHED: 1 });
  });
});
