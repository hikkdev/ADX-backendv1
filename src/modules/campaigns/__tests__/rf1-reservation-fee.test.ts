import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/* AGE-1: the order gate, passing unless a test says otherwise (its own tests: shared/age-gate). */
const ageGate = vi.hoisted(() => ({ assertPartyAdultForOrders: vi.fn(), assertAdultForOrders: vi.fn() }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

/**
 * RF-1 — the reservation fee (the owner, 25 Sep 2026).
 *
 * What is pinned: a checkout at or above the threshold can be reserved —
 * the spots held for 24 hours, a fee of 5% of the total DUE within the
 * hour; under the threshold it is refused; paying the fee takes a wallet
 * hold and re-holds the spots; going ahead releases the fee's hold into
 * the full hold and the gateway is asked for the difference; walking away
 * (or the lapsed day) keeps 10% and leaves the rest in the wallet; an
 * unpaid fee lapses after the hour.
 */

const {
  repository,
  revenueQuote,
  assertCanBook,
  holdForCampaign,
  captureCampaignHold,
  releaseCampaignHold,
  retainReservationFee,
  placeOrder,
  announceOrdersPaid,
  issueTrackingCodes,
  createNotification,
  listAdminUserIds,
  getPlatformSettings,
  logActivity,
} = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    clashingListingIds: vi.fn(),
    holdReservations: vi.fn(),
    clearExpiredReservations: vi.fn(),
    advertiserContext: vi.fn(),
    campaignsWithReservationFeeDue: vi.fn(),
    campaignsWithLapsedReservationHold: vi.fn(),
    clearCampaignReservations: vi.fn(),
    findCampaignRefundByCampaign: vi.fn(),
  },
  revenueQuote: vi.fn(),
  assertCanBook: vi.fn(),
  holdForCampaign: vi.fn(),
  captureCampaignHold: vi.fn(),
  releaseCampaignHold: vi.fn(),
  retainReservationFee: vi.fn(),
  placeOrder: vi.fn(),
  announceOrdersPaid: vi.fn(),
  issueTrackingCodes: vi.fn(),
  createNotification: vi.fn(),
  listAdminUserIds: vi.fn(),
  getPlatformSettings: vi.fn(),
  logActivity: vi.fn(),
}));

const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../advertisers', () => ({ assertCanBook, holdForCampaign, captureCampaignHold, releaseCampaignHold, retainReservationFee }));
vi.mock('../../orders', () => ({ placeOrder, notifyAdmins: vi.fn(), announceOrdersPaid }));
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
vi.mock('../../promo-codes', () => ({
  countRedemptions: vi.fn(),
  discountFor: vi.fn(),
  findPromoByCode: vi.fn(),
  promoProblem: vi.fn(),
  recordRedemption: vi.fn(),
  releaseRedemption: vi.fn(),
}));
vi.mock('../../../shared/audit', () => ({ logActivity, auditDiff: vi.fn(() => ({})) }));

import { authorizeCampaign, campaignPaymentQuote, cancelCampaign, reservationFeeOffer } from '../checkout.service';
import { abandonLapsedReservations, lapseUnpaidReservationFees, payReservationFee, reservationFeePaymentQuote, reservationView, reserveCampaign } from '../reservation.service';

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
  fulfilment: null,
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
    submittedForPaymentAt: null,
    promoCodeId: null,
    promoCode: null,
    designQuoteStatus: null,
    designQuoteAmount: null,
    reservationFeeAmount: null,
    reservationFeeStatus: null,
    reservationFeeDueAt: null,
    reservationFeePaidAt: null,
    reservationFeeHoldId: null,
    reservationHoldUntil: null,
    reservationFeeRetained: null,
    reservationFeeSettledAt: null,
    reservationFeePaymentId: null,
    spots: [spot()],
    pois: [],
    creatives: [],
    codes: [],
    ...over,
  }) as never;

/** A reserved campaign with the fee PAID, as the authorise and the cancel find it. */
const reserved = (over: Record<string, unknown> = {}) =>
  campaign({
    status: 'PENDING_PAYMENT',
    total: new Decimal('34810'),
    spotsSubtotal: new Decimal('28000'),
    feesTotal: new Decimal('1500'),
    gstAmount: new Decimal('5310'),
    discount: new Decimal('0'),
    reservationFeeAmount: new Decimal('1740.50'),
    reservationFeeStatus: 'PAID',
    reservationFeeDueAt: new Date('2026-03-20T11:00:00Z'),
    reservationFeePaidAt: new Date('2026-03-20T10:20:00Z'),
    reservationFeeHoldId: 'hold_fee',
    reservationHoldUntil: new Date('2026-03-21T10:20:00Z'),
    ...over,
  });

function bill(input: { ratePerDay?: string; days: number; spots?: number }) {
  const media = new Decimal(input.ratePerDay ?? 0).times(input.days).times(input.spots ?? 1);
  const gst = media.plus(1500).times('0.18');
  return {
    lines: [
      { kind: 'MEDIA', label: 'Media', taxableValue: media.toFixed(2), gstPct: '0.18' },
      { kind: 'INSTALLATION', label: 'Installation', taxableValue: '1500.00' },
    ],
    gstAmount: gst.toFixed(2),
    grossTotal: media.plus(1500).plus(gst).toFixed(2),
    publisher: { commissionPct: '0.12', commissionSource: 'PLATFORM_DEFAULT' },
  };
}

const owner = { userId: 'usr_owner', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const now = new Date('2026-03-20T10:00:00Z');
const policy = { enabled: true, minCheckoutValue: 30_000, feePct: 5, payWithinMinutes: 60, holdHours: 24, retainPct: 10 };

beforeEach(() => {
  vi.clearAllMocks();
  revenueQuote.mockImplementation(async (input) => bill(input));
  repository.clashingListingIds.mockResolvedValue([]);
  repository.updateCampaign.mockResolvedValue({});
  repository.updateSpot.mockResolvedValue({});
  repository.holdReservations.mockResolvedValue(1);
  repository.clearExpiredReservations.mockResolvedValue(0);
  repository.clearCampaignReservations.mockResolvedValue(1);
  repository.advertiserContext.mockResolvedValue({ id: 'adv_1', agentId: 'agt_1', userId: 'usr_owner', kycStatus: 'VERIFIED' });
  repository.findCampaign.mockImplementation(async () => campaign());
  repository.findCampaignRefundByCampaign.mockResolvedValue(null);
  assertCanBook.mockResolvedValue({ eligible: true, blockedBy: [], launchBlockedBy: [] });
  holdForCampaign.mockResolvedValue({ holdId: 'hold_1' });
  captureCampaignHold.mockResolvedValue({ captured: true });
  releaseCampaignHold.mockResolvedValue({ released: true });
  retainReservationFee.mockResolvedValue({ retained: true });
  placeOrder.mockImplementation(async () => ({ id: 'ord_1' }));
  issueTrackingCodes.mockResolvedValue([]);
  createNotification.mockResolvedValue({});
  listAdminUserIds.mockResolvedValue(['usr_admin']);
  logActivity.mockResolvedValue(undefined);
  getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 }, finance: { opsAuthoriseThreshold: 50_000 }, booking: { reservationFee: policy } });
});

describe('the offer', () => {
  it('is 5% of the total from the threshold up, and not under it', async () => {
    expect(await reservationFeeOffer('34810.00')).toMatchObject({ enabled: true, offered: true, amount: '1740.50', pct: 5, minCheckoutValue: 30_000, payWithinMinutes: 60, holdHours: 24, retainPct: 10 });
    expect(await reservationFeeOffer('29999.99')).toMatchObject({ offered: false, amount: null });
    getPlatformSettings.mockResolvedValue({ booking: { reservationFee: { ...policy, enabled: false } } });
    expect(await reservationFeeOffer('90000.00')).toMatchObject({ enabled: false, offered: false, amount: null });
  });
});

describe('reserving', () => {
  it('holds the spots for 24 hours, prices the fee at 5% and gives the advertiser an hour to pay it', async () => {
    repository.findCampaign.mockImplementation(async () => campaign({ status: 'PENDING_PAYMENT', reservationFeeStatus: 'DUE', reservationFeeAmount: new Decimal('1740.50'), total: new Decimal('34810') }));
    const result = await reserveCampaign(campaign(), owner, now);

    expect(repository.holdReservations).toHaveBeenCalledWith('cmp_1', new Date('2026-03-21T10:00:00Z'), now);
    expect(repository.updateCampaign).toHaveBeenCalledWith(
      'cmp_1',
      expect.objectContaining({
        status: 'PENDING_PAYMENT',
        total: new Decimal('34810.00'),
        reservationFeeAmount: new Decimal('1740.50'),
        reservationFeeStatus: 'DUE',
        reservationFeeDueAt: new Date('2026-03-20T11:00:00Z'),
        reservationHoldUntil: new Date('2026-03-21T10:00:00Z'),
      }),
    );
    expect(result.reservation).toMatchObject({ fee: '1740.50', status: 'DUE', payable: '34810.00' });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_owner', type: 'BOOKING', title: expect.stringContaining('reservation fee') }));
    expect(logActivity).toHaveBeenCalledWith('usr_owner', 'CAMPAIGN_RESERVED', expect.anything());
  });

  it('is refused under the threshold, and when a reservation is already in flight', async () => {
    getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 }, booking: { reservationFee: { ...policy, minCheckoutValue: 100_000 } } });
    await expect(reserveCampaign(campaign(), owner, now)).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_NOT_OFFERED' });
    expect(repository.holdReservations).not.toHaveBeenCalled();

    getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 }, booking: { reservationFee: policy } });
    await expect(reserveCampaign(campaign({ status: 'PENDING_PAYMENT', reservationFeeStatus: 'DUE' }), owner, now)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });
});

describe('paying the fee', () => {
  const due = () => campaign({ status: 'PENDING_PAYMENT', total: new Decimal('34810'), reservationFeeAmount: new Decimal('1740.50'), reservationFeeStatus: 'DUE', reservationFeeDueAt: new Date('2026-03-20T11:00:00Z'), reservationHoldUntil: new Date('2026-03-21T10:00:00Z') });

  it('takes a wallet hold for the fee, holds the spots afresh for 24 hours and reads PAID', async () => {
    const paidAt = new Date('2026-03-20T10:20:00Z');
    repository.findCampaign.mockImplementation(async () => reserved());
    await payReservationFee(due(), 'usr_owner', paidAt);
    expect(holdForCampaign).toHaveBeenCalledWith('adv_1', 'cmp_1', '1740.50');
    expect(repository.holdReservations).toHaveBeenCalledWith('cmp_1', new Date('2026-03-21T10:20:00Z'), paidAt);
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ reservationFeeStatus: 'PAID', reservationFeeHoldId: 'hold_1', reservationFeePaidAt: paidAt, reservationHoldUntil: new Date('2026-03-21T10:20:00Z') }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Reservation fee received') }));
  });

  it('is 409 RESERVATION_FEE_LAPSED after the hour, and a fee already PAID is answered as is', async () => {
    await expect(payReservationFee(due(), 'usr_owner', new Date('2026-03-20T11:00:01Z'))).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_FEE_LAPSED' });
    expect(holdForCampaign).not.toHaveBeenCalled();
    const already = reserved();
    expect(await payReservationFee(already, 'usr_owner', now)).toBe(already);
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  it('quotes the fee for the gateway only while it is due', async () => {
    repository.findCampaign.mockImplementation(async () => due());
    expect(await reservationFeePaymentQuote('cmp_1', owner, now)).toMatchObject({ campaignId: 'cmp_1', advertiserId: 'adv_1', amount: '1740.50' });
    await expect(reservationFeePaymentQuote('cmp_1', owner, new Date('2026-03-20T11:00:01Z'))).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_FEE_LAPSED' });
    repository.findCampaign.mockImplementation(async () => reserved());
    await expect(reservationFeePaymentQuote('cmp_1', owner, now)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('going ahead', () => {
  it('releases the fee hold before the full hold, and marks the fee ADJUSTED', async () => {
    const paid = reserved();
    repository.findCampaign.mockImplementation(async () => paid);
    await authorizeCampaign(paid, new Date('2026-03-20T12:00:00Z'));
    expect(releaseCampaignHold).toHaveBeenCalledWith('hold_fee');
    expect(holdForCampaign).toHaveBeenCalledWith('adv_1', 'cmp_1', '34810.00');
    const releaseOrder = releaseCampaignHold.mock.invocationCallOrder[0]!;
    const holdOrder = holdForCampaign.mock.invocationCallOrder[0]!;
    expect(releaseOrder).toBeLessThan(holdOrder);
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'SCHEDULED', walletHoldId: 'hold_1', reservationFeeStatus: 'ADJUSTED', reservationHoldUntil: null }));
  });

  it('puts the fee hold back when the full hold is refused', async () => {
    const paid = reserved();
    holdForCampaign.mockRejectedValueOnce(new Error('INSUFFICIENT_FUNDS')).mockResolvedValueOnce({ holdId: 'hold_fee_2' });
    await expect(authorizeCampaign(paid, now)).rejects.toThrow('INSUFFICIENT_FUNDS');
    expect(holdForCampaign).toHaveBeenLastCalledWith('adv_1', 'cmp_1', '1740.50');
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', { reservationFeeHoldId: 'hold_fee_2' });
  });

  it('asks the gateway for the total less the fee already paid', async () => {
    repository.findCampaign.mockImplementation(async () => reserved());
    const quote = await campaignPaymentQuote('cmp_1', owner);
    expect(quote.total).toBe('33069.50');
    expect(quote.reservationFeeCredit).toBe('1740.50');
    expect(reservationView(reserved())).toMatchObject({ fee: '1740.50', status: 'PAID', payable: '33069.50' });
  });
});

describe('walking away', () => {
  it('a cancel while reserved keeps 10% for ADX and leaves the rest in the wallet', async () => {
    await cancelCampaign(reserved(), 'Changed our minds', now, 'usr_owner');
    expect(releaseCampaignHold).toHaveBeenCalledWith('hold_fee');
    expect(retainReservationFee).toHaveBeenCalledWith('adv_1', 'cmp_1', '174.05', expect.stringContaining('Changed our minds'));
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ reservationFeeStatus: 'RETAINED', reservationFeeRetained: new Decimal('174.05') }));
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'CANCELLED' }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reservation released', message: expect.stringContaining('INR 174.05 is kept and INR 1566.45 is back') }));
  });

  it('a cancel with the fee still unpaid simply lapses it', async () => {
    await cancelCampaign(reserved({ reservationFeeStatus: 'DUE', reservationFeeHoldId: null }), 'Never mind', now, 'usr_owner');
    expect(retainReservationFee).not.toHaveBeenCalled();
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ reservationFeeStatus: 'LAPSED' }));
  });
});

describe('the sweeps', () => {
  it('lapses a fee not paid within its hour — holds off, LAPSED, back to DRAFT', async () => {
    repository.campaignsWithReservationFeeDue.mockResolvedValue([{ id: 'cmp_1' }]);
    repository.findCampaign.mockImplementation(async () => reserved({ reservationFeeStatus: 'DUE', reservationFeeHoldId: null }));
    expect(await lapseUnpaidReservationFees(now)).toEqual({ lapsed: 1 });
    expect(repository.clearCampaignReservations).toHaveBeenCalledWith('cmp_1');
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'DRAFT', reservationFeeStatus: 'LAPSED' }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reservation lapsed' }));
  });

  it('closes a paid reservation whose day passed unpaid — 10% kept, back to DRAFT', async () => {
    repository.campaignsWithLapsedReservationHold.mockResolvedValue([{ id: 'cmp_1' }]);
    repository.findCampaign.mockImplementation(async () => reserved());
    expect(await abandonLapsedReservations(new Date('2026-03-21T10:30:00Z'))).toEqual({ abandoned: 1 });
    expect(retainReservationFee).toHaveBeenCalledWith('adv_1', 'cmp_1', '174.05', expect.any(String));
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ reservationFeeStatus: 'RETAINED' }));
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', { status: 'DRAFT' });
  });
});
