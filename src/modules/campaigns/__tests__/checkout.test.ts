import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Where a brief becomes a booking and money leaves a wallet.
 *
 * The rules worth holding onto: nothing is charged twice, nothing is charged for
 * a campaign that is not finished, a spot taken by somebody else in the meantime
 * stops the launch rather than being quietly dropped, and a publisher is never
 * told their site is booked before the money for it is held.
 */

const {
  repository,
  revenueQuote,
  assertCanBook,
  holdForCampaign,
  captureCampaignHold,
  releaseCampaignHold,
  placeOrder,
  issueTrackingCodes,
} = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    replaceSpots: vi.fn(),
    listingsByIds: vi.fn(),
    clashingListingIds: vi.fn(),
    campaignsToTransition: vi.fn(),
    // QR-16: the launch gate reads the advertiser's KYC; undefined here means "not held".
    advertiserContext: vi.fn(),
    findCampaignRefundByCampaign: vi.fn(),
    createCampaignRefund: vi.fn(),
  },
  revenueQuote: vi.fn(),
  assertCanBook: vi.fn(),
  holdForCampaign: vi.fn(),
  captureCampaignHold: vi.fn(),
  releaseCampaignHold: vi.fn(),
  placeOrder: vi.fn(),
  issueTrackingCodes: vi.fn(),
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../advertisers', () => ({
  assertCanBook,
  holdForCampaign,
  captureCampaignHold,
  releaseCampaignHold,
}));
vi.mock('../../orders', () => ({ placeOrder, notifyAdmins: vi.fn() }));
vi.mock('../tracking.service', () => ({ issueTrackingCodes }));
// Lot D (Q123): the insertion order is accepted on the version live now; these
// tests are about the money, so it has been.
vi.mock('../../agreements', () => ({
  transactionAcceptance: vi.fn(async (kind: string) => ({ kind, accepted: true, templateVersion: 1, currentVersion: 1, current: true })),
}));

// Lot B: authorisation records the assist for an agent-run campaign; these
// tests are self-serve, so nothing is recorded.
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
// The draft's visit gate lives in `visits`, whose own imports reach past the orders stub above.
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));

import {
  authorizeCampaign,
  cancelCampaign,
  reviewCampaign,
  runCampaignTransitions,
  setCart,
} from '../checkout.service';
import { missingAnswers, triggerPlan } from '../campaigns.service';

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

/** A complete brief — every answer the review requires. */
const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    advertiserId: 'adv_1',
    agentId: null,
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
    /* The brief itself. A path may be chosen without its detail on a draft —
       that is what lets the wizard advance to the screen that collects it — but
       a campaign cannot launch on a path whose detail was never filled in. */
    creativeConfig: {
      objective: 'Brand awareness',
      keyMessage: 'Open all weekend',
      style: 'CLEAN_AND_MINIMAL',
    },
    trackingMethod: 'NONE',
    fulfilment: 'ADX_PRINTS',
    discount: null,
    total: null,
    walletHoldId: null,
    spots: [spot()],
    pois: [],
    creatives: [],
    codes: [],
    ...over,
  }) as never;

/** The revenue module: 18% GST, and a 1,500 installation fee per spot. */
function bill(input: { ratePerDay?: string; days: number; spots?: number }) {
  const media = new Decimal(input.ratePerDay ?? 0).times(input.days).times(input.spots ?? 1);
  const gst = media.plus(1500).times('0.18');
  return {
    lines: [
      { kind: 'MEDIA', label: 'Media', taxableValue: media.toFixed(2) },
      { kind: 'INSTALLATION', label: 'Installation', taxableValue: '1500.00' },
    ],
    netValue: media.plus(1500).toFixed(2),
    gstAmount: gst.toFixed(2),
    grossTotal: media.plus(1500).plus(gst).toFixed(2),
    payable: media.plus(1500).plus(gst).toFixed(2),
    publisher: {
      commissionPct: '0.12',
      commissionSource: 'PLATFORM_DEFAULT',
      commissionAmount: media.times('0.12').toFixed(2),
      netEarnings: media.times('0.88').toFixed(2),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  revenueQuote.mockImplementation(async (input) => bill(input));
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.findCampaign.mockImplementation(async () => campaign());
  holdForCampaign.mockResolvedValue({ holdId: 'hold_1' });
  captureCampaignHold.mockResolvedValue({ captured: true });
  releaseCampaignHold.mockResolvedValue({ released: true });
  placeOrder.mockImplementation(async () => ({ id: 'ord_1' }));
  issueTrackingCodes.mockResolvedValue([]);
});

describe('review', () => {
  it('adds up media, fees and tax the way the payment breakdown reads', async () => {
    const review = await reviewCampaign(campaign());
    expect(review.spotsSubtotal).toBe('28000.00');
    expect(review.feesTotal).toBe('1500.00');
    expect(review.gstAmount).toBe('5310.00');
    expect(review.total).toBe('34810.00');
  });

  it('takes the discount off the total', async () => {
    const review = await reviewCampaign(campaign({ discount: new Decimal('500') }));
    expect(review.discount).toBe('500.00');
    expect(review.total).toBe('34310.00');
  });

  it('reports what is left of the budget, even when it has gone negative', async () => {
    const review = await reviewCampaign(campaign({ budget: new Decimal('20000') }));
    expect(review.budgetRemaining).toBe('-8000.00');
  });

  it('prices every line against the revenue module, never its own arithmetic', async () => {
    await reviewCampaign(campaign());
    expect(revenueQuote).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'lst_1', days: 14, ratePerDay: '2000.00' })
    );
  });

  it('names everything the brief is still missing', async () => {
    const review = await reviewCampaign(campaign({ goal: null, fulfilment: null }));
    expect(review.missing.map((item) => item.field)).toEqual(['goal', 'fulfilment']);
  });

  it('counts artwork per spot when the path produces files', async () => {
    const review = await reviewCampaign(
      campaign({ creativePath: 'STATIC_IMAGES', spots: [spot(), spot({ id: 'spt_2' })] })
    );
    expect(review.creativesExpected).toBe(2);
    expect(review.missing.some((item) => item.field === 'creatives')).toBe(true);
  });
});

describe('authorize', () => {
  it('holds the money, books the spots and raises an order for each', async () => {
    const result = await authorizeCampaign(campaign(), new Date('2026-03-20T10:00:00Z'));

    expect(assertCanBook).toHaveBeenCalledWith('adv_1', '34810.00');
    expect(holdForCampaign).toHaveBeenCalledWith('adv_1', 'cmp_1', '34810.00');
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ advertiserId: 'adv_1', listingId: 'lst_1' })
    );
    expect(repository.updateSpot).toHaveBeenCalledWith(
      'spt_1',
      expect.objectContaining({ status: 'BOOKED', orderId: 'ord_1' })
    );
    expect(result.failedSpots).toEqual([]);
  });

  /**
   * Lot B (Q38): the commission is resolved ONCE, at authorisation, and
   * stamped on the spot — so the accrual charges what was quoted and a rate
   * change next month never re-rates a running flight. One quote per spot:
   * the same call that priced the review is the one the stamp comes from.
   */
  it('stamps the resolved commission on every spot from the one quote that priced it', async () => {
    await authorizeCampaign(
      campaign({ spots: [spot(), spot({ id: 'spt_2', listingId: 'lst_2' })] }),
      new Date('2026-03-20T10:00:00Z')
    );

    expect(repository.updateSpot).toHaveBeenCalledWith(
      'spt_1',
      expect.objectContaining({
        commissionPct: expect.objectContaining({}),
        commissionSource: 'PLATFORM_DEFAULT',
      })
    );
    const stamped = repository.updateSpot.mock.calls.find((call) => call[0] === 'spt_2')?.[1] as {
      commissionPct: Decimal;
      commissionSource: string;
    };
    expect(stamped.commissionPct.toFixed(4)).toBe('0.1200');
    expect(stamped.commissionSource).toBe('PLATFORM_DEFAULT');
    // One resolution per spot — the review's quote, not a second one. (The
    // refreshed campaign the mock hands back afterwards carries only spt_1.)
    expect(revenueQuote.mock.calls.filter((call) => call[0].listingId === 'lst_2')).toHaveLength(1);
  });

  /** A campaign that starts today is running, so the hold becomes a debit now. */
  it('captures the hold when the flight has already started', async () => {
    await authorizeCampaign(campaign(), new Date('2026-04-02T10:00:00Z'));
    expect(captureCampaignHold).toHaveBeenCalledWith('hold_1');
    expect(repository.updateCampaign).toHaveBeenCalledWith(
      'cmp_1',
      expect.objectContaining({ status: 'LIVE' })
    );
  });

  it('leaves a future campaign scheduled with the money only held', async () => {
    await authorizeCampaign(campaign(), new Date('2026-03-20T10:00:00Z'));
    expect(captureCampaignHold).not.toHaveBeenCalled();
    expect(repository.updateCampaign).toHaveBeenCalledWith(
      'cmp_1',
      expect.objectContaining({ status: 'SCHEDULED' })
    );
  });

  it('refuses to charge twice for the same campaign', async () => {
    await expect(authorizeCampaign(campaign({ walletHoldId: 'hold_9' }))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  it('refuses an unfinished brief before touching the wallet', async () => {
    await expect(authorizeCampaign(campaign({ persona: null }))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  it('stops when a spot was booked by somebody else in the meantime', async () => {
    repository.clashingListingIds.mockResolvedValue(['lst_1']);
    await expect(authorizeCampaign(campaign())).rejects.toMatchObject({ statusCode: 409 });
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  /* The money is already held at this point. Failing the whole launch would
     leave it held against nothing, so the spot is reported and the rest run. */
  it('reports a spot whose order could not be raised instead of failing the launch', async () => {
    placeOrder
      .mockRejectedValueOnce(new Error('LISTING_NOT_AVAILABLE'))
      .mockResolvedValueOnce({ id: 'ord_2' });

    const result = await authorizeCampaign(
      campaign({ spots: [spot(), spot({ id: 'spt_2', listingId: 'lst_2' })] }),
      new Date('2026-03-20T10:00:00Z')
    );

    expect(result.failedSpots).toEqual([
      { spotId: 'spt_1', title: 'MG Road Billboard', reason: 'The publisher took this site off the market' },
    ]);
    expect(repository.updateSpot).toHaveBeenCalledWith(
      'spt_2',
      expect.objectContaining({ status: 'BOOKED', orderId: 'ord_2' })
    );
  });

  /* Lot D (Q139): the codes come before the orders, so the artwork the print
     shop receives can already embed them. */
  it('issues the tracking codes before the order loop', async () => {
    const order: string[] = [];
    issueTrackingCodes.mockImplementation(async () => {
      order.push('codes');
      return [];
    });
    placeOrder.mockImplementation(async () => {
      order.push('order');
      return { id: 'ord_1' };
    });
    await authorizeCampaign(campaign(), new Date('2026-03-20T10:00:00Z'));
    expect(issueTrackingCodes).toHaveBeenCalledWith('cmp_1');
    expect(order).toEqual(['codes', 'order']);
  });
});

describe('the cart', () => {
  beforeEach(() => {
    repository.listingsByIds.mockResolvedValue([
      {
        id: 'lst_1',
        title: 'MG Road Billboard',
        ratePerDay: new Decimal('2500'),
        minBookingDays: 7,
      },
    ]);
    repository.replaceSpots.mockResolvedValue([]);
  });

  /** The matcher showed a price; the price that binds is the one read now. */
  it('prices from the listing rather than from what the client sent', async () => {
    await setCart(campaign({ spots: [] }), [{ listingId: 'lst_1', matchScore: 94 }]);
    expect(repository.replaceSpots).toHaveBeenCalledWith('cmp_1', [
      expect.objectContaining({
        ratePerDay: new Decimal('2500'),
        days: 14,
        lineTotal: new Decimal('35000'),
        matchScore: 94,
      }),
    ]);
  });

  it('refuses a flight shorter than the listing accepts', async () => {
    repository.listingsByIds.mockResolvedValue([
      { id: 'lst_1', title: 'MG Road Billboard', ratePerDay: new Decimal('2500'), minBookingDays: 30 },
    ]);
    await expect(setCart(campaign({ spots: [] }), [{ listingId: 'lst_1' }])).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('will not build a cart before the dates are set', async () => {
    await expect(
      setCart(campaign({ startDate: null, endDate: null, spots: [] }), [{ listingId: 'lst_1' }])
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('leaves a spot that has already been paid for alone', async () => {
    await setCart(campaign({ spots: [spot({ status: 'BOOKED' })] }), [{ listingId: 'lst_1' }]);
    expect(repository.replaceSpots).toHaveBeenCalledWith('cmp_1', []);
  });
});

describe('cancel', () => {
  beforeEach(() => {
    repository.findCampaignRefundByCampaign.mockResolvedValue(null);
    repository.createCampaignRefund.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'cref_1', status: 'PENDING', ...data }));
  });

  it('releases a hold that was never spent', async () => {
    const result = await cancelCampaign(
      campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1' }),
      'Client pulled the budget'
    );
    expect(releaseCampaignHold).toHaveBeenCalledWith('hold_1');
    expect(result).toEqual({ released: true, refundNeeded: false, campaignRefundId: null, refundAmount: '0.00' });
    expect(repository.createCampaignRefund).not.toHaveBeenCalled();
  });

  /* A live campaign's money has been captured. A refund is a decision with a
     person behind it (Lot B, Q41): the unused days are valued and recorded as
     a PENDING CampaignRefund for the desk, and no wallet is touched here. */
  it('records what is owed for the refund desk when the money has already moved', async () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const result = await cancelCampaign(
      campaign({
        status: 'LIVE',
        walletHoldId: 'hold_1',
        startDate: new Date('2026-09-10T00:00:00Z'),
        endDate: new Date('2026-09-20T00:00:00Z'),
        spots: [spot({ status: 'LIVE', ratePerDay: new Decimal('1000.00'), quantity: 1 })],
      }),
      'Site vandalised',
      now,
      'usr_adv'
    );
    expect(releaseCampaignHold).not.toHaveBeenCalled();
    expect(result.refundNeeded).toBe(true);
    // 15th to 20th inclusive: six undelivered days, today included.
    expect(result.refundAmount).toBe('6000.00');
    expect(result.campaignRefundId).toBe('cref_1');
    expect(repository.createCampaignRefund).toHaveBeenCalledWith({
      campaignId: 'cmp_1',
      amount: new Decimal('6000.00'),
      reason: 'Site vandalised',
      requestedByUserId: 'usr_adv',
    });
  });

  it('records one refund per campaign, however many times it is cancelled', async () => {
    repository.findCampaignRefundByCampaign.mockResolvedValue({ id: 'cref_existing', amount: new Decimal('6000.00') });
    const result = await cancelCampaign(
      campaign({
        status: 'LIVE',
        walletHoldId: 'hold_1',
        startDate: new Date('2026-09-10T00:00:00Z'),
        endDate: new Date('2026-09-20T00:00:00Z'),
        spots: [spot({ status: 'LIVE', ratePerDay: new Decimal('1000.00'), quantity: 1 })],
      }),
      'Again',
      new Date('2026-09-15T12:00:00Z')
    );
    expect(repository.createCampaignRefund).not.toHaveBeenCalled();
    expect(result.campaignRefundId).toBe('cref_existing');
  });

  it('will not cancel something already finished', async () => {
    await expect(cancelCampaign(campaign({ status: 'COMPLETED' }), 'too late')).rejects.toMatchObject(
      { statusCode: 409 }
    );
  });
});

describe('transitions', () => {
  it('takes a scheduled campaign live and spends its hold', async () => {
    repository.campaignsToTransition.mockResolvedValue([{ id: 'cmp_1', status: 'SCHEDULED' }]);
    repository.findCampaign.mockResolvedValue(
      campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1', spots: [spot({ status: 'BOOKED' })] })
    );

    const result = await runCampaignTransitions(new Date('2026-04-01T00:05:00Z'));

    expect(captureCampaignHold).toHaveBeenCalledWith('hold_1');
    expect(repository.updateSpot).toHaveBeenCalledWith('spt_1', { status: 'LIVE' });
    expect(result.wentLive).toBe(1);
  });

  it('completes a campaign whose end has passed', async () => {
    repository.campaignsToTransition.mockResolvedValue([{ id: 'cmp_1', status: 'LIVE' }]);
    repository.findCampaign.mockResolvedValue(
      campaign({ status: 'LIVE', walletHoldId: 'hold_1', spots: [spot({ status: 'LIVE' })] })
    );

    const result = await runCampaignTransitions(new Date('2026-04-15T00:05:00Z'));

    expect(repository.updateCampaign).toHaveBeenCalledWith(
      'cmp_1',
      expect.objectContaining({ status: 'COMPLETED' })
    );
    expect(result.completed).toBe(1);
  });

  it('skips a campaign whose capture is refused and still moves the rest', async () => {
    // Lot B (B3a): a frozen advertiser's capture is refused inside the
    // movement. One refused capture must not stall every other campaign due
    // on the same tick, and the campaign stays SCHEDULED for the next one.
    repository.campaignsToTransition.mockResolvedValue([
      { id: 'cmp_frozen', status: 'SCHEDULED' },
      { id: 'cmp_1', status: 'SCHEDULED' },
    ]);
    repository.findCampaign.mockImplementation(async (id: string) =>
      id === 'cmp_frozen'
        ? campaign({ id: 'cmp_frozen', status: 'SCHEDULED', walletHoldId: 'hold_frozen', spots: [spot({ status: 'BOOKED' })] })
        : campaign({ status: 'SCHEDULED', walletHoldId: 'hold_1', spots: [spot({ status: 'BOOKED' })] })
    );
    captureCampaignHold.mockImplementation(async (holdId: string) => {
      if (holdId === 'hold_frozen') throw new Error('WALLET_FROZEN');
      return { captured: true };
    });

    const result = await runCampaignTransitions(new Date('2026-04-01T00:05:00Z'));

    expect(result).toEqual({ wentLive: 1, completed: 0, skipped: 1, blocked: 0, awaitingVerification: 0 });
    expect(repository.updateCampaign).not.toHaveBeenCalledWith('cmp_frozen', expect.anything());
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'LIVE' }));
  });
});

/**
 * A draft may be half-answered. A launch may not.
 *
 * The wizard asks a two-part question — choose a path, then fill its detail on
 * the branch screen — so the patch schema has to accept the choice on its own.
 * These pin the other half of that bargain: the campaign cannot go live on a
 * path or a measurement method whose detail was never collected.
 */
describe('a chosen path needs its detail before launch', () => {
  it('names a design brief that was never written', () => {
    const missing = missingAnswers(campaign({ creativeConfig: null }));
    expect(missing.map((item) => item.field)).toContain('creativeConfig');
  });

  it('names a measurement method with no plan behind it', () => {
    const missing = missingAnswers(
      campaign({ trackingMethod: 'LOCATION_LIFT', trackingConfig: null })
    );
    expect(missing.map((item) => item.field)).toContain('trackingConfig');
  });

  /* Two paths carry no detail at all, and must not be asked for one. */
  it('asks nothing extra of a path that has no detail', () => {
    const missing = missingAnswers(
      campaign({ creativePath: 'STATIC_IMAGES', creativeConfig: null, spots: [] })
    );
    expect(missing.map((item) => item.field)).not.toContain('creativeConfig');
  });

  it('asks nothing of a campaign that is not measuring anything', () => {
    const missing = missingAnswers(campaign({ trackingMethod: 'NONE', trackingConfig: null }));
    expect(missing.map((item) => item.field)).not.toContain('trackingConfig');
  });
});

/*
 * Four booking screens collect a trigger and nothing reads it — no scheduler,
 * no delivery rule. The platform is allowed not to have built that; it is not
 * allowed to imply it has. So the answer travels with a flag saying what it
 * really is, the same way package entitlements carry `enforced: false`.
 */
describe('triggers are recorded, not enforced', () => {
  const weather = {
    triggerType: 'WEATHER',
    triggerConfig: { conditions: ['RAIN_OR_DRIZZLE'], response: 'ACTIVATE' },
  };

  it('hands back exactly what was recorded', () => {
    const plan = triggerPlan(weather as never);
    expect(plan.triggerType).toBe('WEATHER');
    expect(plan.triggerConfig).toEqual(weather.triggerConfig);
  });

  it('never claims the platform acts on it', () => {
    expect(triggerPlan(weather as never).enforced).toBe(false);
    expect(triggerPlan(weather as never).basis).toMatch(/Nothing on the platform/);
  });

  it('says a campaign with no trigger simply runs its flight', () => {
    const plan = triggerPlan({ triggerType: 'NONE', triggerConfig: null } as never);
    expect(plan.enforced).toBe(false);
    expect(plan.basis).toMatch(/whole of its flight/);
  });

  /* The last screen before money moves is the one that must say it. */
  it('rides on the review, so the screen before payment can tell the truth', async () => {
    const review = await reviewCampaign(campaign(weather));
    expect(review.triggers).toMatchObject({ triggerType: 'WEATHER', enforced: false });
  });
});
