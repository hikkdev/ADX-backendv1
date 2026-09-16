import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot C (Q88): PENDING_PAYMENT made real.
 *
 * Ops (or the advertiser's agent) prepare a campaign and send it to the
 * advertiser to pay; the spots are held for 24 hours and the clash check
 * treats that hold as booked. Ops may also authorise on the advertiser's
 * behalf, behind a typed confirmation and — above the platform threshold —
 * a second admin.
 */

const {
  repository,
  revenueQuote,
  assertCanBook,
  holdForCampaign,
  captureCampaignHold,
  placeOrder,
  issueTrackingCodes,
  createNotification,
  listAdminUserIds,
  getPlatformSettings,
} = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    clashingListingIds: vi.fn(),
    holdReservations: vi.fn(),
    clearExpiredReservations: vi.fn(),
    advertiserContext: vi.fn(),
  },
  revenueQuote: vi.fn(),
  assertCanBook: vi.fn(),
  holdForCampaign: vi.fn(),
  captureCampaignHold: vi.fn(),
  placeOrder: vi.fn(),
  issueTrackingCodes: vi.fn(),
  createNotification: vi.fn(),
  listAdminUserIds: vi.fn(),
  getPlatformSettings: vi.fn(),
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../advertisers', () => ({
  assertCanBook,
  holdForCampaign,
  captureCampaignHold,
  releaseCampaignHold: vi.fn(),
}));
vi.mock('../../orders', () => ({ placeOrder, notifyAdmins: vi.fn() }));
vi.mock('../tracking.service', () => ({ issueTrackingCodes }));
vi.mock('../../agreements', () => ({
  transactionAcceptance: vi.fn(async (kind: string) => ({ kind, accepted: true, templateVersion: 1, currentVersion: 1, current: true })),
}));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification }));
vi.mock('../../users', () => ({ listAdminUserIds }));
vi.mock('../../app-config', () => ({ getPlatformSettings }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false), ...passThroughFeatureGates() }));
vi.mock('../../pricing', () => ({ assertCityAllows: vi.fn() }));

import {
  authorizeOnBehalf,
  campaignPaymentQuote,
  expireSpotReservations,
  reviewCampaign,
  submitForPayment,
} from '../checkout.service';
import { SlotClashError } from '../campaigns.repository';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  listingId: 'lst_1',
  status: 'RESERVED',
  reservedUntil: null,
  ratePerDay: new Decimal('2000'),
  days: 14,
  quantity: 1,
  lineTotal: new Decimal('28000'),
  startDate: new Date('2026-04-01T00:00:00Z'),
  endDate: new Date('2026-04-14T00:00:00Z'),
  listing: {
    id: 'lst_1',
    title: 'MG Road Billboard',
    city: 'Bengaluru',
    widthFt: new Decimal('20'),
    heightFt: new Decimal('10'),
    estimatedDailyFootfall: null,
    mediaType: { id: 'mt_1', name: 'Billboard', category: 'OUTDOOR' },
    photos: [],
  },
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    advertiserId: 'adv_1',
    agentId: 'agt_1',
    createdByUserId: 'usr_agent',
    name: 'Anita coffee, April',
    status: 'DRAFT',
    brandName: "Anita's Coffee",
    industry: 'Quick service restaurant',
    goal: 'BRAND_AWARENESS',
    awareness: 'BRAND_NEW',
    targetingMethod: 'RADIUS',
    targetLatitude: 12.97,
    targetLongitude: 77.6,
    targetRadiusKm: 5,
    strategy: 'GENERAL',
    persona: 'HIGH_INCOME_CONSUMERS',
    budget: new Decimal('100000'),
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-14T00:00:00Z'),
    creativePath: 'ADX_DESIGN_AGENCY',
    creativeConfig: { objective: 'Brand awareness', keyMessage: 'Open all weekend', style: 'CLEAN_AND_MINIMAL' },
    trackingMethod: 'NONE',
    fulfilment: 'ADX_PRINTS',
    discount: null,
    total: null,
    walletHoldId: null,
    assistIncentiveId: null,
    spots: [spot()],
    pois: [],
    creatives: [],
    codes: [],
    ...over,
  }) as never;

function bill(input: { ratePerDay?: string; days: number; spots?: number }) {
  const media = new Decimal(input.ratePerDay ?? 0).times(input.days).times(input.spots ?? 1);
  const gst = media.plus(1500).times('0.18');
  return {
    lines: [
      { kind: 'MEDIA', label: 'Media', taxableValue: media.toFixed(2) },
      { kind: 'INSTALLATION', label: 'Installation', taxableValue: '1500.00' },
    ],
    gstAmount: gst.toFixed(2),
    grossTotal: media.plus(1500).plus(gst).toFixed(2),
    publisher: { commissionPct: '0.12', commissionSource: 'PLATFORM_DEFAULT' },
  };
}

const admin = { userId: 'usr_admin', isAdmin: true, advertiserId: null, agentId: null };
const agent = { userId: 'usr_agent', isAdmin: false, advertiserId: null, agentId: 'agt_1' };
const owner = { userId: 'usr_owner', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const now = new Date('2026-03-20T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  revenueQuote.mockImplementation(async (input) => bill(input));
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.holdReservations.mockResolvedValue(1);
  repository.clearExpiredReservations.mockResolvedValue(0);
  repository.advertiserContext.mockResolvedValue({ id: 'adv_1', agentId: 'agt_1', userId: 'usr_owner' });
  repository.findCampaign.mockImplementation(async () => campaign({ status: 'PENDING_PAYMENT' }));
  holdForCampaign.mockResolvedValue({ holdId: 'hold_1' });
  captureCampaignHold.mockResolvedValue({ captured: true });
  placeOrder.mockImplementation(async () => ({ id: 'ord_1' }));
  issueTrackingCodes.mockResolvedValue([]);
  createNotification.mockResolvedValue({});
  listAdminUserIds.mockResolvedValue(['usr_admin', 'usr_admin2']);
  getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 }, finance: { opsAuthoriseThreshold: 50_000 } });
});

describe('submit for payment', () => {
  it('moves the campaign to PENDING_PAYMENT, holds the spots for 24 hours and tells the advertiser', async () => {
    const result = await submitForPayment(campaign(), agent, now);

    expect(repository.updateCampaign).toHaveBeenCalledWith(
      'cmp_1',
      expect.objectContaining({ status: 'PENDING_PAYMENT', submittedForPaymentAt: now, submittedByUserId: 'usr_agent' }),
    );
    expect(repository.holdReservations).toHaveBeenCalledWith('cmp_1', new Date('2026-03-21T10:00:00Z'), now);
    expect(result.reservedUntil).toEqual(new Date('2026-03-21T10:00:00Z'));
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_owner', title: 'Your campaign is ready to pay', relatedId: 'cmp_1' }),
    );
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  it('is for ops and the campaign\'s agent, not the advertiser', async () => {
    await expect(submitForPayment(campaign(), owner, now)).rejects.toMatchObject({ statusCode: 403 });
    await expect(submitForPayment(campaign(), { ...agent, agentId: 'agt_other' }, now)).rejects.toMatchObject({ statusCode: 403 });
    await submitForPayment(campaign(), admin, now);
    expect(repository.updateCampaign).toHaveBeenCalledTimes(1);
  });

  it('refuses an unfinished brief, but not a missing insertion order — that is the advertiser\'s own click', async () => {
    await expect(submitForPayment(campaign({ persona: null }), admin, now)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.updateCampaign).not.toHaveBeenCalled();
  });

  it('refuses a campaign that has already been paid for', async () => {
    await expect(submitForPayment(campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1' }), admin, now)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('refuses when a spot was taken by another campaign in the meantime', async () => {
    repository.clashingListingIds.mockResolvedValue(['lst_1']);
    await expect(submitForPayment(campaign(), admin, now)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('G10: refuses 409 when the reservation write, counting again under the listing lock, finds the slots gone', async () => {
    repository.holdReservations.mockRejectedValue(new SlotClashError(['lst_1']));
    await expect(submitForPayment(campaign(), admin, now)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      details: { clashes: [{ spotId: 'spt_1', listingId: 'lst_1', title: 'MG Road Billboard', reason: 'NO_SLOT_LEFT' }] },
    });
    // The hold wrote nothing, and neither did the send: the campaign is not moved to PENDING_PAYMENT.
    expect(repository.updateCampaign).not.toHaveBeenCalled();
  });
});

describe('the reservation and the clash check', () => {
  it('keeps a campaign\'s own reservations out of its own clash answer, and asks for each spot\'s quantity (G10)', async () => {
    await reviewCampaign(campaign({ spots: [spot({ quantity: 3 })] }));
    expect(repository.clashingListingIds).toHaveBeenCalledWith(
      [{ listingId: 'lst_1', quantity: 3 }],
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-14T00:00:00Z'),
      expect.objectContaining({ excludeCampaignId: 'cmp_1' }),
    );
  });

  it('sweeps lapsed reservations back to plain RESERVED', async () => {
    repository.clearExpiredReservations.mockResolvedValue(3);
    expect(await expireSpotReservations(now)).toEqual({ cleared: 3 });
    expect(repository.clearExpiredReservations).toHaveBeenCalledWith(now);
  });
});

describe('the payment quote', () => {
  it('answers what the gateway has to collect for a payable campaign', async () => {
    const quote = await campaignPaymentQuote('cmp_1', owner);
    expect(quote).toMatchObject({ campaignId: 'cmp_1', reference: 'ADX-CMP-2026-482913', advertiserId: 'adv_1', total: '34810.00' });
  });

  it('refuses a campaign that belongs to someone else', async () => {
    await expect(campaignPaymentQuote('cmp_1', { ...owner, advertiserId: 'adv_other' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses one that is already authorised', async () => {
    repository.findCampaign.mockResolvedValue(campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1' }));
    await expect(campaignPaymentQuote('cmp_1', owner)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('authorise on behalf', () => {
  it('needs the campaign reference typed back', async () => {
    await expect(authorizeOnBehalf(campaign({ status: 'PENDING_PAYMENT' }), { confirm: 'ADX-CMP-2026-000000' }, admin, now)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  it('authorises under the threshold with the confirmation alone', async () => {
    const result = await authorizeOnBehalf(campaign({ status: 'PENDING_PAYMENT' }), { confirm: 'ADX-CMP-2026-482913' }, admin, now);
    expect(holdForCampaign).toHaveBeenCalledWith('adv_1', 'cmp_1', '34810.00');
    expect(result.approvedByUserId).toBeNull();
  });

  it('needs a second admin at or above the threshold — 409 FOUR_EYES otherwise', async () => {
    getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 }, finance: { opsAuthoriseThreshold: 30_000 } });
    const prepared = campaign({ status: 'PENDING_PAYMENT' });

    await expect(authorizeOnBehalf(prepared, { confirm: 'ADX-CMP-2026-482913' }, admin, now)).rejects.toMatchObject({
      statusCode: 409,
      code: 'FOUR_EYES',
    });
    // The same admin twice is one pair of eyes.
    await expect(
      authorizeOnBehalf(prepared, { confirm: 'ADX-CMP-2026-482913', approvedByUserId: 'usr_admin' }, admin, now),
    ).rejects.toMatchObject({ statusCode: 409, code: 'FOUR_EYES' });
    // And the second person has to be an admin.
    await expect(
      authorizeOnBehalf(prepared, { confirm: 'ADX-CMP-2026-482913', approvedByUserId: 'usr_owner' }, admin, now),
    ).rejects.toMatchObject({ statusCode: 409, code: 'FOUR_EYES' });
    expect(holdForCampaign).not.toHaveBeenCalled();

    const result = await authorizeOnBehalf(
      prepared,
      { confirm: 'ADX-CMP-2026-482913', approvedByUserId: 'usr_admin2' },
      admin,
      now,
    );
    expect(result.approvedByUserId).toBe('usr_admin2');
    expect(holdForCampaign).toHaveBeenCalledTimes(1);
  });

  it('is an admin path only', async () => {
    await expect(authorizeOnBehalf(campaign(), { confirm: 'ADX-CMP-2026-482913' }, agent, now)).rejects.toMatchObject({ statusCode: 403 });
  });
});
