import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, ZERO, type Money } from '../../shared/money';
import { logActivity } from '../../shared/audit';
import { getPlatformSettings } from '../app-config';
import { holdForCampaign, releaseCampaignHold } from '../advertisers';
import { createNotification } from '../notifications';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import { SlotClashError, type CampaignAggregate } from './campaigns.repository';
import { assertMayAct, type Actor } from './campaigns.service';
import { assertAuthorisable, assertCampaignOrderAge, forfeitReservationFee, reservationFeeOffer, reviewCampaign, type CampaignReview } from './checkout.service';

/**
 * RF-1 — the reservation fee (the owner, 25 Sep 2026).
 *
 * A big checkout can be reserved before it is paid: the spots are held for
 * 24 hours once a fee of 5% of the total lands, and the fee has to land
 * within 60 minutes of reserving. Going ahead folds the fee into the
 * checkout (`checkout.authorizeCampaign` releases its hold and takes the
 * full total; `campaignPaymentQuote` asks the gateway for the difference).
 * Walking away, or letting the hold lapse, keeps 10% of the fee for ADX and
 * leaves the rest in the wallet (`checkout.forfeitReservationFee`). The
 * figures are `settings.booking.reservationFee`.
 *
 * The fee itself is money in the advertiser's wallet under a hold — paid
 * from the balance here, or through a gateway intent with
 * `purpose: 'RESERVATION_FEE'`, which `payments` settles through
 * `settleReservationFeeById` once the capture credited the wallet.
 */

export type ReservationView = {
  fee: Money;
  status: string;
  dueAt: Date | null;
  paidAt: Date | null;
  holdUntil: Date | null;
  /** What ADX kept, once forfeited. */
  retained: Money | null;
  /** The checkout still to pay: the total less the fee when the fee is PAID. */
  payable: Money | null;
  paymentId: string | null;
};

/** The reservation as it stands on the campaign, for the detail view; null when none was ever taken. */
export function reservationView(campaign: CampaignAggregate): ReservationView | null {
  if (!campaign.reservationFeeStatus || !campaign.reservationFeeAmount) return null;
  const fee = new Decimal(campaign.reservationFeeAmount);
  const total = campaign.total ? new Decimal(campaign.total) : null;
  return {
    fee: money(fee),
    status: campaign.reservationFeeStatus,
    dueAt: campaign.reservationFeeDueAt,
    paidAt: campaign.reservationFeePaidAt,
    holdUntil: campaign.reservationHoldUntil,
    retained: campaign.reservationFeeRetained ? money(campaign.reservationFeeRetained) : null,
    payable: total ? money(Decimal.max(campaign.reservationFeeStatus === 'PAID' ? total.minus(fee) : total, ZERO)) : null,
    paymentId: campaign.reservationFeePaymentId,
  };
}

const minutes = (n: number) => n * 60 * 1000;
const hours = (n: number) => n * 60 * 60 * 1000;

async function policy() {
  return (await getPlatformSettings()).booking.reservationFee;
}

async function tellAdvertiser(campaign: CampaignAggregate, note: { title: string; message: string; suggestedAction: string }): Promise<void> {
  try {
    const context = await repository.advertiserContext(campaign.advertiserId);
    if (!context?.userId) return;
    await createNotification({ userId: context.userId, type: 'BOOKING', subtitle: campaign.name, relatedId: campaign.id, relatedType: 'CAMPAIGN', ...note });
  } catch (err) {
    logger.warn('Could not tell the advertiser about their reservation', { campaignId: campaign.id, err });
  }
}

/**
 * POST /campaigns/:id/reserve — the advertiser (or their agent, or ops)
 * reserves the spots against the fee. The campaign is reviewed and checked
 * as a submit-for-payment is (the insertion order is the advertiser's own
 * click, later), the spots are held for `holdHours`, and the fee falls DUE
 * within `payWithinMinutes`. 409 RESERVATION_NOT_OFFERED under the
 * threshold; 409 CONFLICT when a reservation is already in flight.
 */
export async function reserveCampaign(
  campaign: CampaignAggregate,
  actor: Actor,
  now = new Date(),
): Promise<{ campaign: CampaignAggregate; review: CampaignReview; reservation: ReservationView }> {
  assertMayAct(campaign, actor);
  // AGE-1: reserving commits the advertiser to the fee — an order.
  await assertCampaignOrderAge(campaign, actor);
  if (campaign.reservationFeeStatus === 'DUE' || campaign.reservationFeeStatus === 'PAID') {
    throw new ApiError(409, 'CONFLICT', 'This campaign is already reserved. Pay the fee, or pay in full.');
  }
  const review = await reviewCampaign(campaign);
  assertAuthorisable(campaign, review, { agreement: false });
  const offer = await reservationFeeOffer(review.total);
  if (!offer?.offered || !offer.amount) {
    throw new ApiError(
      409,
      'RESERVATION_NOT_OFFERED',
      offer && !offer.enabled ? 'Reserving for a fee is switched off; pay in full to book.' : `Reserving for a fee is offered on checkouts of INR ${offer?.minCheckoutValue ?? '—'} and above; pay in full to book.`,
      { total: review.total, minCheckoutValue: offer?.minCheckoutValue ?? null },
    );
  }
  const terms = await policy();
  const holdUntil = new Date(now.getTime() + hours(terms.holdHours));
  const dueAt = new Date(now.getTime() + minutes(terms.payWithinMinutes));
  try {
    await repository.holdReservations(campaign.id, holdUntil, now);
  } catch (err) {
    if (!(err instanceof SlotClashError)) throw err;
    const clashes = campaign.spots
      .filter((spot) => spot.status === 'RESERVED' && err.listingIds.includes(spot.listingId))
      .map((spot) => ({ spotId: spot.id, listingId: spot.listingId, title: spot.listing.title, reason: 'NO_SLOT_LEFT' as const }));
    throw new ApiError(
      409,
      'CONFLICT',
      `${clashes.map((clash) => clash.title).join(', ')} ${clashes.length === 1 ? 'has' : 'have'} no slot left for these dates. Remove them and pick again.`,
      { clashes },
    );
  }
  await repository.updateCampaign(campaign.id, {
    status: 'PENDING_PAYMENT',
    spotsSubtotal: new Decimal(review.spotsSubtotal),
    feesTotal: new Decimal(review.feesTotal),
    gstAmount: new Decimal(review.gstAmount),
    discount: new Decimal(review.discount),
    total: new Decimal(review.total),
    reservationFeeAmount: new Decimal(offer.amount),
    reservationFeeStatus: 'DUE',
    reservationFeeDueAt: dueAt,
    reservationFeePaidAt: null,
    reservationFeeHoldId: null,
    reservationHoldUntil: holdUntil,
    reservationFeeRetained: null,
    reservationFeeSettledAt: null,
    reservationFeePaymentId: null,
  });
  await logActivity(actor.userId, 'CAMPAIGN_RESERVED', {
    module: 'campaigns',
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { reference: campaign.reference, total: review.total, fee: offer.amount, dueAt: dueAt.toISOString(), holdUntil: holdUntil.toISOString() },
  });
  await tellAdvertiser(campaign, {
    title: 'Spots reserved — pay the reservation fee',
    message: `${campaign.reference} is reserved for ${terms.holdHours} hours once the INR ${offer.amount} reservation fee (${terms.feePct}% of INR ${review.total}) is paid — within ${terms.payWithinMinutes} minutes. It comes off the checkout when you go ahead.`,
    suggestedAction: 'Pay the reservation fee',
  });
  const refreshed = (await repository.findCampaign(campaign.id))!;
  return { campaign: refreshed, review, reservation: reservationView(refreshed)! };
}

/** What `payments` collects for the fee, and for whom; refuses when nothing is due. */
export async function reservationFeePaymentQuote(
  campaignId: string,
  actor: Actor,
  now = new Date(),
): Promise<{ campaignId: string; reference: string; name: string; advertiserId: string; amount: Money; dueAt: Date }> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  assertMayAct(campaign, actor);
  assertFeeDue(campaign, now);
  return {
    campaignId: campaign.id,
    reference: campaign.reference,
    name: campaign.name,
    advertiserId: campaign.advertiserId,
    amount: money(campaign.reservationFeeAmount!),
    dueAt: campaign.reservationFeeDueAt!,
  };
}

function assertFeeDue(campaign: CampaignAggregate, now: Date): void {
  if (campaign.status !== 'PENDING_PAYMENT' || campaign.reservationFeeStatus !== 'DUE' || !campaign.reservationFeeAmount) {
    throw new ApiError(409, 'CONFLICT', 'No reservation fee is due on this campaign.');
  }
  if (campaign.reservationFeeDueAt && campaign.reservationFeeDueAt < now) {
    throw new ApiError(409, 'RESERVATION_FEE_LAPSED', 'The hour to pay the reservation fee has passed. Reserve again, or pay in full.');
  }
}

/**
 * The fee lands: a wallet hold for it against the campaign, the spots held
 * afresh for `holdHours` from now, PAID. From the wallet balance (the
 * advertiser's route) or from the balance a gateway capture just credited
 * (`payments`). Idempotent: a fee already PAID answers the campaign as is.
 */
export async function payReservationFee(
  campaign: CampaignAggregate,
  byUserId: string | null,
  now = new Date(),
  options: { paymentId?: string | null } = {},
): Promise<CampaignAggregate> {
  if (campaign.reservationFeeStatus === 'PAID') return campaign;
  assertFeeDue(campaign, now);
  const terms = await policy();
  const fee = money(campaign.reservationFeeAmount!);
  const { holdId } = await holdForCampaign(campaign.advertiserId, campaign.id, fee);
  const holdUntil = new Date(now.getTime() + hours(terms.holdHours));
  try {
    await repository.holdReservations(campaign.id, holdUntil, now);
  } catch (err) {
    // The spots went between reserving and paying: the money is held for
    // nothing, so it is not — the hold comes off and the fee stays DUE for
    // the advertiser to sort the cart out.
    if (!(err instanceof SlotClashError)) throw err;
    await releaseCampaignHold(holdId);
    throw new ApiError(409, 'CONFLICT', 'A reserved spot has no slot left for these dates. Remove it and reserve again.', { listingIds: err.listingIds });
  }
  await repository.updateCampaign(campaign.id, {
    reservationFeeStatus: 'PAID',
    reservationFeePaidAt: now,
    reservationFeeHoldId: holdId,
    reservationHoldUntil: holdUntil,
    reservationFeePaymentId: options.paymentId ?? null,
  });
  if (byUserId) {
    await logActivity(byUserId, 'CAMPAIGN_RESERVATION_FEE_PAID', {
      module: 'campaigns',
      targetType: 'Campaign',
      targetId: campaign.id,
      metadata: { reference: campaign.reference, fee, holdUntil: holdUntil.toISOString(), paymentId: options.paymentId ?? null },
    });
  }
  await tellAdvertiser(campaign, {
    title: 'Reservation fee received — spots held',
    message: `INR ${fee} received on ${campaign.reference}. The spots are yours until ${holdUntil.toISOString().slice(0, 16).replace('T', ' ')} UTC; pay the balance by then and the fee comes off it.`,
    suggestedAction: 'Pay the balance',
  });
  return (await repository.findCampaign(campaign.id))!;
}

/**
 * `POST /campaigns/:id/reserve/pay` — the fee from the wallet balance, as a
 * person presses it: the age gate (AGE-1), then the ordinary payment. The
 * gateway's capture (`settleReservationFeeById`) does not ask again — its
 * intent did.
 */
export async function payReservationFeeFromWallet(campaign: CampaignAggregate, actor: Actor, now = new Date()): Promise<CampaignAggregate> {
  if (campaign.reservationFeeStatus !== 'PAID') await assertCampaignOrderAge(campaign, actor);
  return payReservationFee(campaign, actor.userId, now);
}

/** For `payments`: the capture credited the wallet; the fee is taken from it now. */
export async function settleReservationFeeById(campaignId: string, paymentId: string, now = new Date()): Promise<CampaignAggregate> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  return payReservationFee(campaign, null, now, { paymentId });
}

/**
 * The lifecycle job's first sweep: a fee not paid within its hour lapses —
 * the spot holds come off, the fee reads LAPSED, and the campaign goes back
 * to DRAFT unless ops had sent it to pay (then it stays PENDING_PAYMENT
 * under their 24-hour hold as before).
 */
export async function lapseUnpaidReservationFees(now = new Date()): Promise<{ lapsed: number }> {
  const due = await repository.campaignsWithReservationFeeDue(now);
  let lapsed = 0;
  for (const { id } of due) {
    const campaign = await repository.findCampaign(id);
    if (!campaign || campaign.reservationFeeStatus !== 'DUE') continue;
    await repository.clearCampaignReservations(campaign.id);
    await repository.updateCampaign(campaign.id, {
      status: campaign.submittedForPaymentAt ? 'PENDING_PAYMENT' : 'DRAFT',
      reservationFeeStatus: 'LAPSED',
      reservationFeeSettledAt: now,
      reservationHoldUntil: null,
    });
    await tellAdvertiser(campaign, {
      title: 'Reservation lapsed',
      message: `The hour to pay the reservation fee on ${campaign.reference} passed, so the spots are no longer held. Reserve again, or pay in full to book.`,
      suggestedAction: 'Open the campaign',
    });
    lapsed += 1;
  }
  return { lapsed };
}

/**
 * The second sweep: a paid reservation whose 24 hours passed unpaid is
 * treated as walked away from — ADX keeps its part of the fee, the rest
 * stays in the wallet, and the campaign goes back to DRAFT.
 */
export async function abandonLapsedReservations(now = new Date()): Promise<{ abandoned: number }> {
  const lapsed = await repository.campaignsWithLapsedReservationHold(now);
  let abandoned = 0;
  for (const { id } of lapsed) {
    const campaign = await repository.findCampaign(id);
    if (!campaign || campaign.reservationFeeStatus !== 'PAID') continue;
    try {
      await forfeitReservationFee(campaign, 'The 24-hour hold lapsed without payment', null, now);
      await repository.clearCampaignReservations(campaign.id);
      await repository.updateCampaign(campaign.id, { status: campaign.submittedForPaymentAt ? 'PENDING_PAYMENT' : 'DRAFT' });
      abandoned += 1;
    } catch (err) {
      logger.error('Could not close a lapsed reservation', { campaignId: campaign.id, err });
    }
  }
  return { abandoned };
}
