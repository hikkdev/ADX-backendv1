import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Campaigns lot (2 Oct 2026): the Prisma side of the console's reads —
 * the scope and search every read narrows by, each launch gate as a where,
 * the engagement read (two queries per page, never one per row), and the
 * landing-page list's search and advertiser.
 */

type AnyFn = (...args: any[]) => any;
const { prisma } = vi.hoisted(() => ({ prisma: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>> }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
vi.mock('../../listings', () => ({ slotsHeldWith: vi.fn() }));

import { PAID_UNLAUNCHED_WHERE, campaignCityWhere, campaignScopeWhere, prismaCampaignsRepository as repository, waitingPrefilter } from '../prisma-campaigns.repository';

beforeEach(() => {
  prisma['campaignTrackingCode'] = { findMany: vi.fn<AnyFn>() };
  prisma['trackingEvent'] = { groupBy: vi.fn<AnyFn>() };
  prisma['campaign'] = { findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0), groupBy: vi.fn<AnyFn>(async () => []) };
  prisma['landingPage'] = { findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0), groupBy: vi.fn<AnyFn>(async () => []) };
});

describe('the scope every console read narrows by', () => {
  it('is empty with nothing asked', () => {
    expect(campaignScopeWhere({})).toEqual({});
  });

  it('searches the campaign and its advertiser — the business, the person, the ADV-/ADX- ids', () => {
    const where = campaignScopeWhere({ q: 'ADV-19' }) as { AND: [{ OR: object[] }] };
    const like = { contains: 'ADV-19', mode: 'insensitive' };
    expect(where.AND[0].OR).toEqual([
      { name: like },
      { reference: like },
      { brandName: like },
      {
        advertiser: {
          OR: [
            { name: like },
            { companyName: like },
            { displayId: like },
            { user: { is: { OR: [{ name: like }, { firstName: like }, { lastName: like }, { displayId: like }] } } },
          ],
        },
      },
    ]);
  });

  it('reads the city by its key, the typed market for a row with no key (Lot X-B)', () => {
    const spelling = { equals: 'Bengaluru', mode: 'insensitive' };
    expect(campaignCityWhere({ city: ' Bengaluru ', cityId: 'city_blr' })).toEqual({ OR: [{ targetMarketCityId: 'city_blr' }, { targetMarketCityId: null, targetMarket: spelling }] });
    expect(campaignCityWhere({ city: 'Bengaluru', cityId: null })).toEqual({ targetMarketCityId: null, targetMarket: spelling });
  });

  it('keeps a flight that overlaps the days, and the goals asked for', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-11-01T00:00:00Z');
    expect(campaignScopeWhere({ advertiserId: 'adv_1', from, to, goal: ['LOCAL_FOOTFALL'] })).toEqual({
      AND: [{ advertiserId: 'adv_1' }, { endDate: { gte: from } }, { startDate: { lt: to } }, { goal: { in: ['LOCAL_FOOTFALL'] } }],
    });
  });
});

describe('each launch gate as a where', () => {
  it('reads the payment, the fee and the quote off the campaign', () => {
    expect(waitingPrefilter('RESERVATION_FEE')).toEqual({ status: 'PENDING_PAYMENT', reservationFeeStatus: 'DUE' });
    expect(waitingPrefilter('PAYMENT')).toEqual({ status: 'PENDING_PAYMENT', OR: [{ reservationFeeStatus: null }, { reservationFeeStatus: { not: 'DUE' } }] });
    expect(waitingPrefilter('DESIGN_QUOTE')).toEqual({ status: 'PENDING_PAYMENT', creativePath: 'ADX_DESIGN_AGENCY', OR: [{ designQuoteStatus: null }, { designQuoteStatus: 'QUOTED' }] });
  });

  it('reads KYC on the paid-and-unlaunched only, and the spots’ orders for the publisher and the agent', () => {
    expect(waitingPrefilter('KYC')).toEqual({ AND: [PAID_UNLAUNCHED_WHERE, { advertiser: { kycStatus: { not: 'VERIFIED' } } }] });
    expect(PAID_UNLAUNCHED_WHERE).toEqual({ OR: [{ status: 'SCHEDULED' }, { status: 'PENDING_PAYMENT', reservationFeeStatus: 'PAID' }] });
    expect(waitingPrefilter('PUBLISHER')).toEqual({
      status: 'SCHEDULED',
      spots: { some: { status: { not: 'CANCELLED' }, order: { is: { status: { in: ['PENDING_PUBLISHER'] } } } } },
    });
    expect(waitingPrefilter('AGENT')).toEqual({
      status: 'SCHEDULED',
      spots: { some: { status: { not: 'CANCELLED' }, order: { is: { status: { in: ['PENDING_AGENT', 'AGENT_REJECTED'] } } } } },
    });
  });

  it('reads a superset for the artwork — the derivation drops a superseded creative', () => {
    expect(waitingPrefilter('ARTWORK')).toEqual({
      status: { in: ['PENDING_PAYMENT', 'SCHEDULED'] },
      creatives: { some: { fileUrl: { not: null }, status: { not: 'APPROVED' } } },
    });
  });

  it('asks the candidates once, with the scope, the population and the gates OR-ed', async () => {
    await repository.gateCandidates({ q: 'x', reasons: ['KYC', 'ARTWORK'], paidOnly: true }, 5000);
    const args = prisma['campaign']!['findMany']!.mock.calls[0]![0] as { where: { AND: object[] }; take: number; select: Record<string, unknown> };
    expect(args.take).toBe(5000);
    expect(args.where.AND).toEqual([campaignScopeWhere({ q: 'x' }), PAID_UNLAUNCHED_WHERE, { OR: [waitingPrefilter('KYC'), waitingPrefilter('ARTWORK')] }]);
    // The person's row column by column — never an email, a birth date or a credential.
    const advertiser = (args.select['advertiser'] as { select: { user: { select: Record<string, boolean> } } }).select;
    expect(Object.keys(advertiser.user.select).sort()).toEqual(['closedAt', 'displayId', 'firstName', 'id', 'isActive', 'lastName', 'name']);
    // The landing page as the detail's summary — four columns, never the blocks.
    expect(args.select['landingPage']).toEqual({ select: { id: true, slug: true, status: true, publishedAt: true } });
  });
});

describe('the engagement per campaign', () => {
  it('reads the page in two queries — the codes, then their events by type — and folds them per campaign', async () => {
    prisma['campaignTrackingCode']!['findMany']!.mockResolvedValue([
      { id: 'code_1', campaignId: 'cmp_1', scans: 10 },
      { id: 'code_2', campaignId: 'cmp_1', scans: 5 },
      { id: 'code_3', campaignId: 'cmp_2', scans: 1 },
    ]);
    prisma['trackingEvent']!['groupBy']!.mockResolvedValue([
      { codeId: 'code_1', type: 'VIEW', _count: { _all: 7 } },
      { codeId: 'code_2', type: 'VIEW', _count: { _all: 2 } },
      { codeId: 'code_2', type: 'CTA_CLICK', _count: { _all: 3 } },
      { codeId: 'code_3', type: 'FORM_SUBMIT', _count: { _all: 1 } },
    ]);
    expect(await repository.performanceTotals(['cmp_1', 'cmp_2', 'cmp_3'])).toEqual({
      cmp_1: { scans: 15, views: 9, ctaClicks: 3, enquiries: 0 },
      cmp_2: { scans: 1, views: 0, ctaClicks: 0, enquiries: 1 },
    });
    expect(prisma['trackingEvent']!['groupBy']).toHaveBeenCalledWith({
      by: ['codeId', 'type'],
      where: { codeId: { in: ['code_1', 'code_2', 'code_3'] }, type: { in: ['VIEW', 'CTA_CLICK', 'FORM_SUBMIT'] } },
      _count: { _all: true },
    });
  });

  it('asks nothing for an empty page', async () => {
    expect(await repository.performanceTotals([])).toEqual({});
    expect(prisma['campaignTrackingCode']!['findMany']).not.toHaveBeenCalled();
  });
});

describe('the landing-page list', () => {
  it('searches the slug, the campaign and its advertiser, and counts the chips with the search but not the status', async () => {
    await repository.listLandingPages({ q: 'anita', status: ['PUBLISHED'], page: 1, pageSize: 20 });
    const like = { contains: 'anita', mode: 'insensitive' };
    const findArgs = prisma['landingPage']!['findMany']!.mock.calls[0]![0] as { where: { AND: [{ OR: object[] }, object] } };
    expect(findArgs.where.AND[1]).toEqual({ status: { in: ['PUBLISHED'] } });
    expect(findArgs.where.AND[0].OR[0]).toEqual({ slug: like });
    const groupArgs = prisma['landingPage']!['groupBy']!.mock.calls[0]![0] as { where: unknown };
    expect(groupArgs.where).toEqual(findArgs.where.AND[0]);
  });

  it('keeps the campaign’s narrow advertiser beside the row and hands the party row on for the service', async () => {
    prisma['landingPage']!['findMany']!.mockResolvedValue([
      {
        id: 'lp_1',
        campaignId: 'cmp_1',
        slug: 'anita',
        campaign: {
          id: 'cmp_1',
          reference: 'R',
          name: 'N',
          status: 'LIVE',
          advertiserId: 'adv_1',
          advertiser: { id: 'adv_1', name: 'Anita Foods', companyName: 'Anita Pvt', displayId: 'ADV-1', kycStatus: 'VERIFIED', userId: 'usr_1', suspensionScopes: [], user: null },
        },
      },
    ]);
    const page = await repository.listLandingPages({ page: 1, pageSize: 20 });
    expect(page.items[0]!.campaign!.advertiser).toEqual({ id: 'adv_1', name: 'Anita Foods', companyName: 'Anita Pvt' });
    expect(page.items[0]!.advertiserRow).toMatchObject({ id: 'adv_1', displayId: 'ADV-1', userId: 'usr_1' });
  });
});
