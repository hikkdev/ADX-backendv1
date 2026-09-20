import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * QR-16 (the owner, 17 Sep 2026): KYC gates the LAUNCH, not the booking.
 *
 * An unverified advertiser may browse, fill a cart and pay; what they
 * cannot do is run. Pinned: a campaign authorised with KYC under
 * `launchBlockedBy` is held SCHEDULED even when it starts today — the hold
 * uncaptured — and the advertiser is told; a verified one goes LIVE as
 * before; the lifecycle tick leaves a due campaign of an unverified
 * advertiser SCHEDULED (counted `awaitingVerification`), tells ops and the
 * advertiser once a day, and launches it on the first tick after the
 * record is verified; a context without the column (an older read) does
 * not hold anything.
 */

const { repository, revenueQuote, advertisers, orders, agreements, issueTrackingCodes, notifications } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    clashingListingIds: vi.fn(),
    campaignsToTransition: vi.fn(),
    advertiserContext: vi.fn(),
  },
  revenueQuote: vi.fn(),
  advertisers: {
    assertCanBook: vi.fn(),
    holdForCampaign: vi.fn(),
    captureCampaignHold: vi.fn(),
    releaseCampaignHold: vi.fn(),
  },
  orders: { placeOrder: vi.fn(), notifyAdmins: vi.fn(async () => undefined) },
  agreements: { transactionAcceptance: vi.fn() },
  issueTrackingCodes: vi.fn(),
  notifications: { createNotification: vi.fn(async () => ({})) },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../orders', () => orders);
vi.mock('../../agreements', () => agreements);
vi.mock('../tracking.service', () => ({ issueTrackingCodes }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../notifications', () => notifications);

import { authorizeCampaign, resetLaunchWarnings, runCampaignTransitions } from '../checkout.service';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  listingId: 'lst_1',
  status: 'RESERVED',
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

const creative = (over: Record<string, unknown> = {}) => ({
  id: 'crt_1',
  spotId: 'spt_1',
  fileUrl: 'https://cdn/a.png',
  status: 'APPROVED',
  resubmissionOfId: null,
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
    targetingMethod: 'RADIUS',
    targetLatitude: 12.97,
    targetLongitude: 77.6,
    targetRadiusKm: 5,
    strategy: 'GENERAL',
    persona: 'HIGH_INCOME_CONSUMERS',
    budget: new Decimal('100000'),
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-14T00:00:00Z'),
    creativePath: 'STATIC_IMAGES',
    trackingMethod: 'NONE',
    fulfilment: 'ADX_PRINTS',
    discount: null,
    total: null,
    walletHoldId: null,
    spots: [spot()],
    pois: [],
    creatives: [creative()],
    codes: [],
    ...over,
  }) as never;

const due = (over: Record<string, unknown> = {}) => campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1', spots: [spot({ status: 'BOOKED' })], ...over });

function bill(input: { ratePerDay?: string; days: number; spots?: number }) {
  const media = new Decimal(input.ratePerDay ?? 0).times(input.days).times(input.spots ?? 1);
  const gst = media.times('0.18');
  return {
    lines: [{ kind: 'MEDIA', label: 'Media', taxableValue: media.toFixed(2) }],
    gstAmount: gst.toFixed(2),
    grossTotal: media.plus(gst).toFixed(2),
    publisher: { commissionPct: '0.12', commissionSource: 'PLATFORM_DEFAULT' },
  };
}

const eligibility = (launchBlockedBy: string[]) => ({ eligible: true, blockedBy: [], launchBlockedBy, wallet: null });

beforeEach(() => {
  vi.clearAllMocks();
  resetLaunchWarnings();
  revenueQuote.mockImplementation(async (input) => bill(input));
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.findCampaign.mockImplementation(async () => campaign());
  repository.advertiserContext.mockResolvedValue({ id: 'adv_1', agentId: null, userId: 'usr_adv', kycStatus: 'PENDING' });
  advertisers.assertCanBook.mockResolvedValue(eligibility(['KYC']));
  advertisers.holdForCampaign.mockResolvedValue({ holdId: 'hold_1' });
  advertisers.captureCampaignHold.mockResolvedValue({ captured: true });
  orders.placeOrder.mockResolvedValue({ id: 'ord_1' });
  issueTrackingCodes.mockResolvedValue([]);
  agreements.transactionAcceptance.mockResolvedValue({ kind: 'INSERTION_ORDER', accepted: true, templateVersion: 1, currentVersion: 1, current: true });
});

describe('authorising while unverified', () => {
  it('takes the money and books the spots, but holds a campaign due today SCHEDULED, uncaptured, and tells the advertiser', async () => {
    const today = campaign({ startDate: new Date('2026-03-20T00:00:00Z') });
    repository.findCampaign.mockResolvedValue(today);
    await authorizeCampaign(today, new Date('2026-03-20T10:00:00Z'));
    expect(advertisers.holdForCampaign).toHaveBeenCalledWith('adv_1', 'cmp_1', '33040.00');
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'SCHEDULED', launchedAt: null, walletHoldId: 'hold_1' }));
    expect(advertisers.captureCampaignHold).not.toHaveBeenCalled();
    expect(orders.placeOrder).toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_adv', type: 'KYC', suggestedAction: 'Verify your identity', relatedId: 'cmp_1', relatedType: 'CAMPAIGN' }),
    );
  });

  it('goes LIVE at once, captured, for a verified advertiser starting today', async () => {
    advertisers.assertCanBook.mockResolvedValue(eligibility([]));
    const today = campaign({ startDate: new Date('2026-03-20T00:00:00Z') });
    repository.findCampaign.mockResolvedValue(today);
    await authorizeCampaign(today, new Date('2026-03-20T10:00:00Z'));
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'LIVE' }));
    expect(advertisers.captureCampaignHold).toHaveBeenCalledWith('hold_1');
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});

describe('the lifecycle tick', () => {
  beforeEach(() => {
    repository.campaignsToTransition.mockResolvedValue([{ id: 'cmp_1', status: 'SCHEDULED' }]);
    repository.findCampaign.mockResolvedValue(due());
  });

  it('leaves a due campaign of an unverified advertiser SCHEDULED and tells ops and the advertiser', async () => {
    const result = await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
    expect(result).toEqual({ wentLive: 0, completed: 0, skipped: 0, blocked: 0, awaitingVerification: 1 });
    expect(advertisers.captureCampaignHold).not.toHaveBeenCalled();
    expect(repository.updateCampaign).not.toHaveBeenCalled();
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Launch held: advertiser not verified', expect.stringContaining('ADX-CMP-2026-482913'), 'cmp_1');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', type: 'KYC', relatedId: 'cmp_1' }));
  });

  it('nags once a day, not once a tick', async () => {
    await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
    await runCampaignTransitions(new Date('2026-04-01T06:05:00Z'));
    expect(orders.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    await runCampaignTransitions(new Date('2026-04-02T06:00:00Z'));
    expect(orders.notifyAdmins).toHaveBeenCalledTimes(2);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  it('launches on the first tick after the record is verified', async () => {
    repository.advertiserContext.mockResolvedValue({ id: 'adv_1', agentId: null, userId: 'usr_adv', kycStatus: 'VERIFIED' });
    const result = await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
    expect(result).toEqual({ wentLive: 1, completed: 0, skipped: 0, blocked: 0, awaitingVerification: 0 });
    expect(advertisers.captureCampaignHold).toHaveBeenCalledWith('hold_1');
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'LIVE' }));
  });

  it('does not hold anything on a context that does not carry the status', async () => {
    repository.advertiserContext.mockResolvedValue({ id: 'adv_1', agentId: null, userId: 'usr_adv' });
    const result = await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
    expect(result.wentLive).toBe(1);
  });
});
