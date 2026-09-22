import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * T-B — a write answers the same view its read answers.
 *
 * `PUT /campaigns/:id/spots` and the `campaign` inside
 * `POST /campaigns/:id/submit-for-payment`'s envelope answer the detail view
 * `GET /campaigns/:id` answers (triggers, spot review marks, refund, landing
 * page, `city`, `spotCount`); `POST /campaigns/:id/creatives` answers the
 * desk's row (the artwork with its campaign and spot); the landing-page
 * unpublish answers the review list's row (the page with its campaign and
 * advertiser). A console updates what it holds from the answer.
 */

const { repository, listings, notifications, orders, audit, spotReviews } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    findCampaignBare: vi.fn(),
    updateCampaign: vi.fn(),
    findCampaignRefundByCampaign: vi.fn(),
    landingPageSummary: vi.fn(),
    listingsByIds: vi.fn(),
    replaceSpots: vi.fn(),
    clashingListingIds: vi.fn(),
    createCreative: vi.fn(),
    findCreative: vi.fn(),
    holdReservations: vi.fn(),
    advertiserContext: vi.fn(),
    findLandingPage: vi.fn(),
    updateLandingPage: vi.fn(),
    findLandingPageView: vi.fn(),
  },
  listings: { getContentRules: vi.fn(async () => []), getListingWithPublisher: vi.fn(), listContentCategories: vi.fn() },
  notifications: { createNotification: vi.fn(async () => ({})) },
  orders: { notifyAdmins: vi.fn(async () => undefined), placeOrder: vi.fn() },
  audit: { logActivity: vi.fn(async () => undefined) },
  spotReviews: new Map<string, string>([['spt_1', 'rev_1']]),
}));

const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../listings', () => listings);
vi.mock('../../notifications', () => notifications);
vi.mock('../../orders', () => orders);
vi.mock('../../advertisers', () => ({ getAdvertiserForUser: vi.fn(async () => null), assertCanBook: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn(async () => null), findWorkingAgentProfile: vi.fn(async () => null), findAgentTier: vi.fn() }));
vi.mock('../../qr', () => ({ IMAGE_CACHE_CONTROL: 'no-store', clampSize: (n: number) => n, toPngBuffer: vi.fn() }));
vi.mock('../../revenue', () => ({
  quote: vi.fn(async () => ({
    lines: [{ kind: 'MEDIA', label: 'Media', taxableValue: '28000.00' }],
    netValue: '28000.00',
    gstAmount: '5040.00',
    grossTotal: '33040.00',
    payable: '33040.00',
    publisher: { commissionPct: '0.12', commissionSource: 'PLATFORM_DEFAULT', commissionAmount: '3360.00', netEarnings: '24640.00' },
  })),
}));
vi.mock('../../users', () => ({ listAdminUserIds: vi.fn(async () => []) }));
vi.mock('../../app-config', () => ({
  getPlatformSettings: vi.fn(async () => ({ marketplace: { minBookingDays: 1 }, finance: { opsAuthoriseThreshold: '1000000' } })),
}));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false), ...passThroughFeatureGates() }));
vi.mock('../../pricing', () => ({ assertCityAllows: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../agreements', () => ({
  transactionAcceptance: vi.fn(async (kind: string) => ({ kind, accepted: true, templateVersion: 1, currentVersion: 1, current: true })),
}));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../ai', () => ({ assertLandingPageQuota: vi.fn(), recordLandingPageGeneration: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));

import {
  getCampaignHandler,
  setCartHandler,
  submitForPaymentHandler,
  unpublishLandingPageHandler,
  uploadCreativeHandler,
} from '../campaigns.controller';
import { registerSpotReviewPort, resetSpotReviewPort } from '../spot-review.port';

const listing = () => ({
  id: 'lst_1',
  title: 'MG Road Billboard',
  city: 'Bengaluru',
  address: 'MG Road',
  latitude: 12.97,
  longitude: 77.6,
  ratePerDay: new Decimal('2000'),
  widthFt: new Decimal('20'),
  heightFt: new Decimal('10'),
  areaSqFt: null,
  illumination: null,
  estimatedDailyFootfall: null,
  minBookingDays: null,
  availableNow: true,
  mediaType: { id: 'mt_1', name: 'Billboard', category: 'OUTDOOR' },
  venueType: null,
  photos: [],
});

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  campaignId: 'cmp_1',
  listingId: 'lst_1',
  status: 'RESERVED',
  reservedUntil: null,
  ratePerDay: new Decimal('2000'),
  days: 14,
  quantity: 1,
  lineTotal: new Decimal('28000'),
  startDate: new Date('2026-04-01T00:00:00Z'),
  endDate: new Date('2026-04-14T00:00:00Z'),
  listing: listing(),
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    advertiserId: 'adv_1',
    agentId: null,
    createdByUserId: 'usr_adv',
    name: 'Anita coffee, April',
    status: 'DRAFT',
    brandName: "Anita's Coffee",
    industry: 'QSR',
    goal: 'BRAND_AWARENESS',
    awareness: 'BRAND_NEW',
    targetingMethod: 'CITY',
    targetLocation: 'Bengaluru',
    targetMarket: 'Bengaluru',
    targetMarkets: ['Bengaluru'],
    targetLatitude: null,
    targetLongitude: null,
    targetRadiusKm: null,
    strategy: 'GENERAL',
    persona: null,
    budget: new Decimal('100000'),
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-14T00:00:00Z'),
    creativePath: 'STATIC_IMAGES',
    creativeConfig: null,
    trackingMethod: 'NONE',
    triggerType: null,
    triggerConfig: null,
    fulfilment: 'ADX_PRINTS',
    discount: null,
    total: null,
    walletHoldId: null,
    contentCategoryId: 'cat_food',
    spots: [spot()],
    pois: [],
    creatives: [],
    codes: [],
    advertiser: { id: 'adv_1', name: 'Anita', companyName: "Anita's Coffee" },
    brand: null,
    ...over,
  }) as never;

function res() {
  const r: Record<string, any> = {};
  r['status'] = vi.fn(() => r);
  r['json'] = vi.fn((b: unknown) => {
    r['sent'] = b;
    return r;
  });
  r['body'] = () => r['sent'].data;
  return r;
}
const admin = { sub: 'usr_ops', roles: ['ADMIN'] };
const req = (over: Record<string, unknown> = {}) =>
  ({ params: { id: 'cmp_1' }, body: {}, query: {}, user: admin, get: () => undefined, ...over }) as never;

const refund = { id: 'crf_1', campaignId: 'cmp_1', amount: new Decimal('10'), status: 'PENDING', reason: 'Cancelled', releasedAt: null };
const landing = { id: 'lp_1', slug: 'anita-april', status: 'PUBLISHED', publishedAt: new Date('2026-03-20T00:00:00Z') };

/** What GET /campaigns/:id carries beyond the aggregate — the fields a write must carry too. */
const detailMarks = {
  city: 'Bengaluru',
  spotCount: 1,
  multiMarketWarning: false,
  triggers: expect.anything(),
  refund: expect.objectContaining({ id: 'crf_1', amount: '10.00' }),
  landingPage: expect.objectContaining({ id: 'lp_1', slug: 'anita-april', url: expect.stringContaining('anita-april') }),
  spots: [expect.objectContaining({ id: 'spt_1', reviewed: true, reviewId: 'rev_1' })],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSpotReviewPort();
  registerSpotReviewPort({ reviewIdsForSpots: async () => spotReviews });
  repository.findCampaign.mockImplementation(async () => campaign());
  repository.findCampaignRefundByCampaign.mockResolvedValue(refund);
  repository.landingPageSummary.mockResolvedValue(landing);
  repository.updateCampaign.mockResolvedValue({});
});

describe('the campaign detail view on the writes', () => {
  it('GET /campaigns/:id — the view the writes are measured against', async () => {
    const r = res();
    await getCampaignHandler(req(), r as never);
    expect(r['body']()).toMatchObject(detailMarks);
  });

  it('PUT /campaigns/:id/spots answers the detail view of the campaign with its new cart', async () => {
    repository.listingsByIds.mockResolvedValue([listing()]);
    repository.replaceSpots.mockResolvedValue(undefined);
    const r = res();
    await setCartHandler(req({ body: { items: [{ listingId: 'lst_1', matchScore: 94 }] } }), r as never);
    expect(r['body']()).toMatchObject({ ...detailMarks, id: 'cmp_1' });
    expect(repository.landingPageSummary).toHaveBeenCalledWith('cmp_1');
  });

  it('POST /campaigns/:id/submit-for-payment keeps its envelope and carries the detail view as `campaign`', async () => {
    // a finished brief: persona chosen, ADX designs the artwork
    repository.findCampaign.mockImplementation(async () =>
      campaign({ persona: 'HIGH_INCOME_CONSUMERS', creativePath: 'ADX_DESIGN_AGENCY', creativeConfig: { objective: 'Brand awareness', keyMessage: 'Open all weekend', style: 'CLEAN_AND_MINIMAL' } }),
    );
    repository.holdReservations.mockResolvedValue(1);
    repository.clashingListingIds.mockResolvedValue([]);
    repository.advertiserContext.mockResolvedValue(null);
    const r = res();
    await submitForPaymentHandler(req(), r as never);
    const body = r['body']();
    expect(body.review).toBeDefined();
    expect(body.reservedUntil).toBeInstanceOf(Date);
    expect(body.campaign).toMatchObject({ ...detailMarks, id: 'cmp_1' });
  });
});

describe('POST /campaigns/:id/creatives', () => {
  it('answers the desk row — the artwork with its campaign and spot, as GET /campaigns/creatives/:id does', async () => {
    repository.createCreative.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'crt_new', ...data }));
    repository.findCreative.mockImplementation(async (id: string) => ({
      id,
      campaignId: 'cmp_1',
      spotId: 'spt_1',
      status: 'IN_REVIEW',
      fileUrl: 'https://cdn/a.png',
      campaign: {
        id: 'cmp_1',
        reference: 'ADX-CMP-2026-482913',
        name: 'Anita coffee, April',
        status: 'DRAFT',
        advertiser: { id: 'adv_1', name: 'Anita', companyName: null },
      },
      spot: { id: 'spt_1', listingId: 'lst_1', listing: { id: 'lst_1', title: 'MG Road Billboard', city: 'Bengaluru' } },
    }));
    const r = res();
    await uploadCreativeHandler(
      req({ body: { spotId: 'spt_1', fileUrl: 'https://cdn/a.png', fileName: 'a.png', mimeType: 'image/png', widthPx: 2000, heightPx: 1000 } }),
      r as never,
    );
    expect(r['status']).toHaveBeenCalledWith(201);
    expect(repository.findCreative).toHaveBeenCalledWith('crt_new');
    expect(r['body']()).toMatchObject({
      id: 'crt_new',
      campaign: expect.objectContaining({ reference: 'ADX-CMP-2026-482913', advertiser: expect.objectContaining({ id: 'adv_1' }) }),
      spot: expect.objectContaining({ listing: expect.objectContaining({ title: 'MG Road Billboard' }) }),
    });
  });
});

describe('POST /campaigns/:id/landing-page/unpublish', () => {
  it('answers the review list row — the page with its campaign and advertiser', async () => {
    const page = { id: 'lp_1', campaignId: 'cmp_1', slug: 'anita-april', status: 'PUBLISHED', publishedAt: new Date(), version: 2, blocks: [] };
    repository.findLandingPage.mockResolvedValue(page);
    repository.findCampaignBare.mockResolvedValue({ id: 'cmp_1', name: 'Anita coffee, April', createdByUserId: 'usr_adv' });
    repository.updateLandingPage.mockResolvedValue({ ...page, status: 'DRAFT', publishedAt: null });
    repository.findLandingPageView.mockResolvedValue({
      ...page,
      status: 'DRAFT',
      publishedAt: null,
      campaign: {
        id: 'cmp_1',
        reference: 'ADX-CMP-2026-482913',
        name: 'Anita coffee, April',
        status: 'DRAFT',
        advertiserId: 'adv_1',
        advertiser: { id: 'adv_1', name: 'Anita', companyName: null },
      },
    });
    const r = res();
    await unpublishLandingPageHandler(req({ body: { reason: 'Claims a discount the brief never mentioned.' } }), r as never);
    expect(repository.findLandingPageView).toHaveBeenCalledWith('cmp_1');
    expect(r['body']()).toMatchObject({
      id: 'lp_1',
      status: 'DRAFT',
      campaign: expect.objectContaining({ reference: 'ADX-CMP-2026-482913', advertiser: expect.objectContaining({ name: 'Anita' }) }),
    });
  });
});
