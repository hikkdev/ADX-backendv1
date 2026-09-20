import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot D (Q120/Q123): the two gates at the end of the booking flow.
 *
 * The insertion order blocks the payment: nothing is held until the
 * advertiser has accepted the version live now. The artwork does NOT block
 * the payment — the review names it as outstanding — and instead holds the
 * launch: a SCHEDULED campaign whose start has arrived stays SCHEDULED, ops
 * are told, and the tick carries on with everybody else.
 */

const { repository, revenueQuote, advertisers, orders, agreements, issueTrackingCodes } = vi.hoisted(() => ({
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
vi.mock('../../notifications', () => ({ createNotification: vi.fn(async () => ({})) }));

import { authorizeCampaign, resetLaunchWarnings, reviewCampaign, runCampaignTransitions } from '../checkout.service';

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
  status: 'IN_REVIEW',
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
    creatives: [creative({ status: 'APPROVED' })],
    codes: [],
    ...over,
  }) as never;

const accepted = (current: boolean, accepted = true) => ({
  kind: 'INSERTION_ORDER',
  accepted,
  templateVersion: accepted ? 1 : null,
  currentVersion: 2,
  current,
});

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

beforeEach(() => {
  vi.clearAllMocks();
  resetLaunchWarnings();
  revenueQuote.mockImplementation(async (input) => bill(input));
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.findCampaign.mockImplementation(async () => campaign());
  advertisers.holdForCampaign.mockResolvedValue({ holdId: 'hold_1' });
  advertisers.captureCampaignHold.mockResolvedValue({ captured: true });
  orders.placeOrder.mockResolvedValue({ id: 'ord_1' });
  issueTrackingCodes.mockResolvedValue([]);
  agreements.transactionAcceptance.mockResolvedValue(accepted(true));
});

describe('the insertion order (Q123)', () => {
  it('the review carries where the agreement stands', async () => {
    const review = await reviewCampaign(campaign());
    expect(review.agreements).toEqual([accepted(true)]);
    expect(review.missing).toEqual([]);
    expect(agreements.transactionAcceptance).toHaveBeenCalledWith('INSERTION_ORDER', { campaignId: 'cmp_1' });
  });

  it('names AGREEMENT_REQUIRED among what is missing when it has not been accepted', async () => {
    agreements.transactionAcceptance.mockResolvedValue(accepted(false, false));
    const review = await reviewCampaign(campaign());
    expect(review.missing).toEqual([{ step: 'AUTHORIZE', field: 'AGREEMENT_REQUIRED', label: 'Accept the insertion order' }]);
  });

  it('an acceptance of an older version is not current', async () => {
    agreements.transactionAcceptance.mockResolvedValue(accepted(false, true));
    const review = await reviewCampaign(campaign());
    expect(review.missing[0]?.label).toContain('version 2');
  });

  it('authorisation refuses 403 AGREEMENT_REQUIRED before any money is held', async () => {
    agreements.transactionAcceptance.mockResolvedValue(accepted(false, false));
    await expect(authorizeCampaign(campaign())).rejects.toMatchObject({ statusCode: 403, code: 'AGREEMENT_REQUIRED' });
    expect(advertisers.assertCanBook).not.toHaveBeenCalled();
    expect(advertisers.holdForCampaign).not.toHaveBeenCalled();
  });

  it('an incomplete brief is still reported as the brief, ahead of the agreement', async () => {
    agreements.transactionAcceptance.mockResolvedValue(accepted(false, false));
    await expect(authorizeCampaign(campaign({ goal: null }))).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('the artwork (Q120)', () => {
  it('the review names unapproved artwork as outstanding without adding it to what is missing', async () => {
    const review = await reviewCampaign(campaign({ creatives: [creative({ status: 'IN_REVIEW' })] }));
    expect(review.outstanding).toEqual([
      { code: 'CREATIVES_NOT_APPROVED', label: expect.stringContaining('1 artwork'), creativeIds: ['crt_1'] },
    ]);
    expect(review.missing).toEqual([]);
  });

  it('authorisation takes the hold with the artwork still in review', async () => {
    const inReview = campaign({ creatives: [creative({ status: 'IN_REVIEW' })] });
    repository.findCampaign.mockResolvedValue(inReview);
    const result = await authorizeCampaign(inReview, new Date('2026-03-20T10:00:00Z'));
    expect(advertisers.holdForCampaign).toHaveBeenCalled();
    expect(result.review.outstanding[0]?.code).toBe('CREATIVES_NOT_APPROVED');
  });

  it('a superseded refusal is not outstanding once the re-upload is approved', async () => {
    const review = await reviewCampaign(
      campaign({ creatives: [creative({ id: 'old', status: 'REJECTED' }), creative({ id: 'new', status: 'APPROVED', resubmissionOfId: 'old' })] }),
    );
    expect(review.outstanding).toEqual([]);
    expect(review.creativesUploaded).toBe(1);
  });

  describe('going live', () => {
    const due = (over: Record<string, unknown> = {}) =>
      campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1', spots: [spot({ status: 'BOOKED' })], ...over });

    beforeEach(() => {
      repository.campaignsToTransition.mockResolvedValue([{ id: 'cmp_1', status: 'SCHEDULED' }]);
    });

    it('goes LIVE when every artwork with a file is approved', async () => {
      repository.findCampaign.mockResolvedValue(due());
      const result = await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
      expect(result).toEqual({ wentLive: 1, completed: 0, skipped: 0, blocked: 0, awaitingVerification: 0 });
      expect(advertisers.captureCampaignHold).toHaveBeenCalledWith('hold_1');
    });

    it('stays SCHEDULED, uncaptured, and ops are told, when artwork is not approved', async () => {
      repository.findCampaign.mockResolvedValue(due({ creatives: [creative({ status: 'CHANGES_REQUESTED' })] }));
      const result = await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
      expect(result).toEqual({ wentLive: 0, completed: 0, skipped: 0, blocked: 1, awaitingVerification: 0 });
      expect(advertisers.captureCampaignHold).not.toHaveBeenCalled();
      expect(repository.updateCampaign).not.toHaveBeenCalled();
      expect(orders.notifyAdmins).toHaveBeenCalledWith('Launch blocked: artwork not approved', expect.stringContaining('ADX-CMP-2026-482913'), 'cmp_1');
    });

    it('tells ops once a day, not once a tick', async () => {
      repository.findCampaign.mockResolvedValue(due({ creatives: [creative({ status: 'IN_REVIEW' })] }));
      await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
      await runCampaignTransitions(new Date('2026-04-01T06:05:00Z'));
      expect(orders.notifyAdmins).toHaveBeenCalledTimes(1);
      await runCampaignTransitions(new Date('2026-04-02T06:00:00Z'));
      expect(orders.notifyAdmins).toHaveBeenCalledTimes(2);
    });

    it('a blocked campaign does not hold the others back', async () => {
      repository.campaignsToTransition.mockResolvedValue([
        { id: 'cmp_1', status: 'SCHEDULED' },
        { id: 'cmp_2', status: 'SCHEDULED' },
      ]);
      repository.findCampaign.mockImplementation(async (id: string) =>
        id === 'cmp_1' ? due({ creatives: [creative({ status: 'IN_REVIEW' })] }) : due({ id: 'cmp_2', walletHoldId: 'hold_2' }),
      );
      const result = await runCampaignTransitions(new Date('2026-04-01T06:00:00Z'));
      expect(result).toEqual({ wentLive: 1, completed: 0, skipped: 0, blocked: 1, awaitingVerification: 0 });
      expect(advertisers.captureCampaignHold).toHaveBeenCalledWith('hold_2');
    });
  });
});
