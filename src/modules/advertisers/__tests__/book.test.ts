import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — the agent's advertiser book, its detail card and the brands.
 *
 * Pinned: the per-row next action (Check in beats Follow up beats metrics),
 * dormancy named once at 45 days, spend as money from committed campaigns
 * only, fields with no source absent rather than zero-filled, the histogram
 * counted without the chip, and brand cards with their counts.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findBook: vi.fn(),
    campaignFacts: vi.fn(),
    openVisits: vi.fn(),
    findAccount: vi.fn(),
    campaignsOf: vi.fn(),
    spotsOf: vi.fn(),
    feedOf: vi.fn(),
    createActivity: vi.fn(),
    listActivity: vi.fn(),
    brandsOf: vi.fn(),
    findBrand: vi.fn(),
    brandCounts: vi.fn(),
    campaignsOfBrand: vi.fn(),
  },
}));

vi.mock('../book/prisma-book.repository', () => ({ prismaBookRepository: repository }));

import { Decimal } from '../../../shared/money';
import { advertiserBook, advertiserSummary, brandCards, nextActionFor, recordAccountActivity } from '../book/book.service';
import { DORMANT_AFTER_DAYS, advertiserBookQuerySchema } from '../book/book.schema';

const NOW = new Date('2026-09-11T06:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const account = (over: Record<string, unknown> = {}) => ({
  id: 'adv_1',
  displayId: 'ADV-0101-2601',
  name: 'Anita Rao',
  companyName: "Anita's Coffee",
  mobile: '+919800000001',
  city: 'MG Road',
  kycStatus: 'VERIFIED',
  activatedAt: day(-100),
  createdAt: day(-120),
  ...over,
});

const facts = (over: Record<string, unknown> = {}) => ({
  total: 2,
  live: 1,
  spend: new Decimal('43400.00'),
  lastCreatedAt: day(-10),
  industry: 'QSR',
  subCategory: 'Coffee',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findBook.mockResolvedValue({ items: [account()], total: 1, counts: { ACTIVE: 1, PENDING: 0 } });
  repository.campaignFacts.mockResolvedValue(new Map([['adv_1', facts()]]));
  repository.openVisits.mockResolvedValue(new Map());
});

describe('the next action', () => {
  it('is metrics for a healthy account', () => {
    expect(nextActionFor(account(), facts(), undefined, NOW)).toEqual({ kind: 'METRICS' });
  });

  it('is Check in when a visit is on the calendar, whatever else is true', () => {
    const visit = { id: 'vst_1', advertiserId: 'adv_1', status: 'SCHEDULED', scheduledFor: day(0) };
    expect(nextActionFor(account(), facts({ lastCreatedAt: day(-90) }), visit, NOW)).toEqual({
      kind: 'CHECK_IN',
      visitId: 'vst_1',
      visitStatus: 'SCHEDULED',
      at: day(0).toISOString(),
    });
  });

  it('is Follow up after 45 quiet days, with the line the card prints', () => {
    expect(nextActionFor(account(), facts({ lastCreatedAt: day(-45) }), undefined, NOW)).toEqual({
      kind: 'FOLLOW_UP',
      dormantDays: DORMANT_AFTER_DAYS,
      line: 'No campaigns in 45 days',
    });
    expect(nextActionFor(account(), facts({ lastCreatedAt: day(-44) }), undefined, NOW)).toEqual({ kind: 'METRICS' });
  });

  it('counts quiet from activation for an account that never ran a campaign', () => {
    const action = nextActionFor(account({ activatedAt: day(-60) }), undefined, undefined, NOW);
    expect(action).toEqual({ kind: 'FOLLOW_UP', dormantDays: 60, line: 'No campaigns yet — 60 days' });
  });
});

describe('the book', () => {
  it('draws the row from the account and its campaigns, with the industry the newest campaign named', async () => {
    const page = await advertiserBook('agt_1', advertiserBookQuerySchema.parse({}), NOW);
    expect(page.total).toBe(1);
    expect(page.counts).toEqual({ ACTIVE: 1, PENDING: 0 });
    expect(page.items[0]).toMatchObject({
      name: "Anita's Coffee",
      industry: 'QSR',
      city: 'MG Road',
      active: true,
      campaigns: { total: 2, live: 1 },
      spend: '43400.00',
      nextAction: { kind: 'METRICS' },
    });
  });

  it('leaves industry null and spend at zero money for an account with no campaigns', async () => {
    repository.campaignFacts.mockResolvedValue(new Map());
    const page = await advertiserBook('agt_1', advertiserBookQuerySchema.parse({}), NOW);
    expect(page.items[0]!.industry).toBeNull();
    expect(page.items[0]!.spend).toBe('0.00');
  });

  it('parses the chips as a comma list and refuses an unknown one', () => {
    expect(advertiserBookQuerySchema.parse({ status: 'ACTIVE,PENDING' }).status).toEqual(['ACTIVE', 'PENDING']);
    expect(advertiserBookQuerySchema.safeParse({ status: 'LIVE' }).success).toBe(false);
  });
});

describe('the detail card', () => {
  it('composes the metrics, the campaigns and the feed', async () => {
    repository.findAccount.mockResolvedValue(account());
    repository.campaignsOf.mockResolvedValue([
      { id: 'cmp_1', name: 'Diwali Season Push', status: 'LIVE', budget: new Decimal('18400.00'), startDate: day(-5), endDate: day(20), spots: 3, brandId: null, awareness: null, industry: 'QSR', createdAt: day(-10) },
    ]);
    repository.spotsOf.mockResolvedValue(5);
    repository.feedOf.mockResolvedValue([{ kind: 'CAMPAIGN_LIVE', at: day(-5), title: 'Campaign went live: Diwali Season Push', detail: null }]);
    const summary = await advertiserSummary('adv_1', NOW);
    expect(summary.metrics).toEqual({ campaigns: 2, spots: 5, spend: '43400.00' });
    expect(summary.campaigns[0]).toMatchObject({ name: 'Diwali Season Push', status: 'LIVE', budget: '18400.00', spots: 3 });
    expect(summary.activity[0]!.title).toBe('Campaign went live: Diwali Season Push');
  });

  it('logs a follow-up against the account', async () => {
    repository.findAccount.mockResolvedValue(account());
    repository.createActivity.mockImplementation(async (data) => ({ id: 'act_1', ...data }));
    const view = await recordAccountActivity('adv_1', 'agt_1', { kind: 'FOLLOW_UP', note: 'Called, will renew in Oct' }, 'usr_agent', NOW);
    expect(repository.createActivity).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1', agentId: 'agt_1', kind: 'FOLLOW_UP' }));
    expect(view).toEqual({ id: 'act_1', kind: 'FOLLOW_UP', note: 'Called, will renew in Oct', at: NOW.toISOString() });
  });
});

describe('brands', () => {
  it('carries the counts and lifetime spend, and keeps isActive for the readers that already exist', async () => {
    repository.brandsOf.mockResolvedValue([
      { id: 'brd_1', advertiserId: 'adv_1', name: 'Nykaa Beauty', sector: 'GENERAL', logoUrl: null, website: null, isActive: true, createdAt: NOW, updatedAt: NOW },
      { id: 'brd_2', advertiserId: 'adv_1', name: 'Old Line', sector: 'GENERAL', logoUrl: null, website: null, isActive: false, createdAt: NOW, updatedAt: NOW },
    ]);
    repository.brandCounts.mockResolvedValue(new Map([['brd_1', { campaigns: 3, live: 1, scheduled: 1, spend: new Decimal('61200.00'), awareness: 'BRAND_NEW', industry: 'QSR', subCategory: 'Coffee' }]]));
    const cards = await brandCards('adv_1');
    expect(cards[0]).toMatchObject({ name: 'Nykaa Beauty', isActive: true, archived: false, awareness: 'BRAND_NEW', industry: 'QSR', subCategory: 'Coffee', campaigns: { total: 3, live: 1, scheduled: 1 }, lifetimeSpend: '61200.00' });
    expect(cards[1]).toMatchObject({ archived: true, campaigns: { total: 0, live: 0, scheduled: 0 }, lifetimeSpend: '0.00', awareness: null });
  });
});
