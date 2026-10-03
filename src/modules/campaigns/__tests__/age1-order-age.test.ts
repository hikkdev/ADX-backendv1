import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * AGE-1 (the owner, 29 Sep 2026): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders."
 *
 * The campaign doors that place an order ask the advertiser's account
 * holder — whoever presses — before anything is priced, held or booked:
 * the checkout from the wallet (the advertiser or their agent), the desk's
 * authorise on the advertiser's behalf, reserving against the fee, paying
 * the fee from the wallet, and accepting ADX's design quote. Declining a
 * quote asks nothing, and a gateway's settlement does not ask again (its
 * intent did, at `POST /payments/intents`).
 */

const { repository, revenueQuote, holdForCampaign, assertPartyAdultForOrders, listAdminUserIds, getPlatformSettings } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    updateSpot: vi.fn(),
    clashingListingIds: vi.fn(),
    holdReservations: vi.fn(),
    advertiserContext: vi.fn(),
  },
  revenueQuote: vi.fn(),
  holdForCampaign: vi.fn(),
  assertPartyAdultForOrders: vi.fn(),
  listAdminUserIds: vi.fn(),
  getPlatformSettings: vi.fn(),
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../revenue', () => ({ quote: revenueQuote }));
vi.mock('../../advertisers', () => ({
  assertCanBook: vi.fn(),
  holdForCampaign,
  captureCampaignHold: vi.fn(),
  releaseCampaignHold: vi.fn(),
  retainReservationFee: vi.fn(),
}));
vi.mock('../../orders', () => ({ placeOrder: vi.fn(), notifyAdmins: vi.fn() }));
vi.mock('../tracking.service', () => ({ issueTrackingCodes: vi.fn() }));
vi.mock('../../agreements', () => ({ transactionAcceptance: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../users', () => ({ listAdminUserIds }));
vi.mock('../../app-config', () => ({ getPlatformSettings }));
vi.mock('../../promo-codes', () => ({
  countRedemptions: vi.fn(),
  discountFor: vi.fn(),
  findPromoByCode: vi.fn(),
  promoProblem: vi.fn(),
  recordRedemption: vi.fn(),
  releaseRedemption: vi.fn(),
}));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), assertPartyAdultForOrders }));

import { ageRequiredError } from '../../../shared/age-gate';
import { ApiError } from '../../../shared/errors';
import { authorizeCampaignById, authorizeOnBehalf, checkoutCampaign, respondToDesignQuote } from '../checkout.service';
import { payReservationFeeFromWallet, reserveCampaign } from '../reservation.service';

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    advertiserId: 'adv_1',
    agentId: 'agt_1',
    createdByUserId: 'usr_agent',
    name: 'Anita coffee, April',
    status: 'DRAFT',
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: new Date('2026-11-14T00:00:00Z'),
    fulfilment: 'ADX_PRINTS',
    walletHoldId: null,
    designQuoteStatus: null,
    designQuoteAmount: null,
    reservationFeeAmount: null,
    reservationFeeStatus: null,
    reservationFeeDueAt: null,
    spots: [
      {
        id: 'spt_1',
        listingId: 'lst_1',
        status: 'RESERVED',
        ratePerDay: new Decimal('2000'),
        days: 14,
        quantity: 1,
        lineTotal: new Decimal('28000'),
        fulfilment: null,
        listing: { id: 'lst_1', title: 'MG Road Billboard', city: 'Bengaluru', photos: [] },
      },
    ],
    pois: [],
    creatives: [],
    codes: [],
    ...over,
  }) as never;

const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const agent = { userId: 'usr_agent', isAdmin: false, advertiserId: null, agentId: 'agt_1' };
const admin = { userId: 'usr_admin', isAdmin: true, advertiserId: null, agentId: null };

/** What the pricing step throws in these tests — reaching it means the gate let the order through. */
const PRICED = new Error('priced');

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  revenueQuote.mockRejectedValue(PRICED);
  repository.findCampaign.mockResolvedValue(campaign());
  getPlatformSettings.mockResolvedValue({ finance: { opsAuthoriseThreshold: '500000' }, booking: { reservationFee: { enabled: true, pct: 5, minCheckoutValue: 1000, payWithinMinutes: 60, holdHours: 24, retainPct: 10 } } });
  listAdminUserIds.mockResolvedValue(['usr_admin', 'usr_admin_2']);
});

describe('the checkout (POST /campaigns/:id/authorize)', () => {
  it("refuses 403 AGE_REQUIRED before anything is priced or held", async () => {
    assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('MISSING'));
    const err = await caught(checkoutCampaign(campaign(), advertiser as never));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ statusCode: 403, code: 'AGE_REQUIRED', details: { reason: 'MISSING', self: true } });
    expect(revenueQuote).not.toHaveBeenCalled();
    expect(holdForCampaign).not.toHaveBeenCalled();
    expect(repository.updateCampaign).not.toHaveBeenCalled();
  });

  it("asks about the advertiser's person, with whoever pressed named as the actor", async () => {
    assertPartyAdultForOrders.mockResolvedValue(undefined);
    expect(await caught(checkoutCampaign(campaign(), agent as never))).toBe(PRICED);
    expect(assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_agent' });
  });

  it('an adult goes on to the ordinary authorise', async () => {
    assertPartyAdultForOrders.mockResolvedValue(undefined);
    expect(await caught(checkoutCampaign(campaign(), advertiser as never))).toBe(PRICED);
    expect(revenueQuote).toHaveBeenCalled();
  });
});

describe("the desk's authorise on the advertiser's behalf", () => {
  it("checks the advertiser's person, not the admin's, after the typed reference", async () => {
    assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('UNDER_18', false));
    const err = await caught(authorizeOnBehalf(campaign(), { confirm: 'ADX-CMP-2026-482913' }, admin as never));
    expect(err).toMatchObject({ code: 'AGE_REQUIRED', details: { reason: 'UNDER_18', self: false } });
    expect(assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_admin' });
    expect(revenueQuote).not.toHaveBeenCalled();
  });

  it('a wrong reference is still refused first, for what it is', async () => {
    const err = await caught(authorizeOnBehalf(campaign(), { confirm: 'nope' }, admin as never));
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(assertPartyAdultForOrders).not.toHaveBeenCalled();
  });
});

describe("the gateway's settlement", () => {
  it('does not ask again — the intent already did', async () => {
    expect(await caught(authorizeCampaignById('cmp_1'))).toBe(PRICED);
    expect(assertPartyAdultForOrders).not.toHaveBeenCalled();
  });
});

describe('the reservation fee', () => {
  it('reserving is refused before a spot is held', async () => {
    assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('MISSING'));
    const err = await caught(reserveCampaign(campaign(), advertiser as never));
    expect(err).toMatchObject({ code: 'AGE_REQUIRED' });
    expect(repository.holdReservations).not.toHaveBeenCalled();
    expect(revenueQuote).not.toHaveBeenCalled();
  });

  it('paying the fee from the wallet is refused before the hold', async () => {
    assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('UNDER_18'));
    const due = campaign({ status: 'PENDING_PAYMENT', reservationFeeStatus: 'DUE', reservationFeeAmount: new Decimal('1740.50'), reservationFeeDueAt: new Date(Date.now() + 30 * 60_000) });
    const err = await caught(payReservationFeeFromWallet(due, advertiser as never));
    expect(err).toMatchObject({ code: 'AGE_REQUIRED', details: { reason: 'UNDER_18' } });
    expect(holdForCampaign).not.toHaveBeenCalled();
  });

  it('a fee already paid answers as it is, without asking', async () => {
    const paid = campaign({ status: 'PENDING_PAYMENT', reservationFeeStatus: 'PAID' });
    expect(await payReservationFeeFromWallet(paid, advertiser as never)).toBe(paid);
    expect(assertPartyAdultForOrders).not.toHaveBeenCalled();
  });
});

describe("ADX's design quote", () => {
  const quoted = () => campaign({ designQuoteStatus: 'QUOTED', designQuoteAmount: new Decimal('4500') });

  it('accepting it is an order — refused before the answer is written', async () => {
    assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('MISSING'));
    const err = await caught(respondToDesignQuote(quoted(), 'ACCEPTED', 'usr_adv'));
    expect(err).toMatchObject({ code: 'AGE_REQUIRED' });
    expect(assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_adv' });
    expect(repository.updateCampaign).not.toHaveBeenCalled();
  });

  it('declining it asks nothing', async () => {
    assertPartyAdultForOrders.mockRejectedValue(ageRequiredError('MISSING'));
    await respondToDesignQuote(quoted(), 'DECLINED', 'usr_adv');
    expect(assertPartyAdultForOrders).not.toHaveBeenCalled();
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ designQuoteStatus: 'DECLINED' }));
  });
});
