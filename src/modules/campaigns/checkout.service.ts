import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, ZERO, type Money } from '../../shared/money';
import {
  assertCanBook,
  captureCampaignHold,
  holdForCampaign,
  releaseCampaignHold,
} from '../advertisers';
import { findAgentTier } from '../agents';
import { transactionAcceptance, type AgreementStanding } from '../agreements';
import { getPlatformSettings } from '../app-config';
import { createNotification } from '../notifications';
import { notifyAdmins, placeOrder } from '../orders';
import { listAdminUserIds } from '../users';
import { recordIncentive } from '../payouts';
import { quote as revenueQuote } from '../revenue';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { CampaignStatus } from '../../shared/database';
import { SlotClashError, type CampaignAggregate, type NewSpot } from './campaigns.repository';
import {
  assertMayAct,
  flightDays,
  missingAnswers,
  triggerPlan,
  type Actor,
  type MissingAnswer,
  type TriggerPlan,
} from './campaigns.service';
import { issueTrackingCodes } from './tracking.service';
import { currentCreatives, outstandingCreatives } from './moderation.service';
import { openCampaignRefund } from './refunds/campaign-refunds.service';
import { campaignInvoicing } from './invoicing.port';
import type { IssuedInvoiceSummary } from './invoicing.port';

/**
 * Review, authorize, launch, cancel.
 *
 * The arithmetic is not done here. Every spot is priced by the revenue module —
 * the same call an invoice makes — so a campaign total and the invoice that
 * follows it cannot disagree. This file's job is to add up what revenue says,
 * hold the money, and convert paid spots into orders.
 *
 * The order of operations at authorization matters and is deliberate:
 *
 *   1. the brief is complete
 *   2. nothing in the cart has been booked out from under it
 *   3. the insertion order has been accepted, on the version live now (Lot D, Q123)
 *   4. the advertiser is allowed to book at all
 *   5. money is held
 *   6. tracking codes are minted, so the artwork can embed them (Lot D, Q139)
 *   7. orders are raised
 *
 * The artwork is NOT in that list (Lot D, Q120): authorisation takes the hold
 * with the creatives still in review. The review names them as outstanding,
 * and the two things that need approved artwork — printing, going LIVE — are
 * gated where they happen instead.
 *
 * Money before orders, because an order tells a publisher their site is booked,
 * and telling somebody that when the payment then fails is worse than failing
 * one step earlier. Orders after the hold, and each one wrapped, because a
 * publisher's listing going unavailable mid-launch must not strand the rest.
 */

export type CampaignLine = {
  spotId: string;
  listingId: string;
  title: string;
  city: string | null;
  photoUrl: string | null;
  mediaTypeName: string | null;
  size: string | null;
  ratePerDay: Money;
  days: number;
  quantity: number;
  /** Media value, before fees and tax. */
  lineTotal: Money;
  /** Printing, installation and the platform fee, as the revenue module rates them. */
  fees: { label: string; amount: Money }[];
  gst: Money;
  gross: Money;
};

export type CampaignReview = {
  campaignId: string;
  reference: string;
  status: CampaignAggregate['status'];
  lines: CampaignLine[];
  /** The frame's payment breakdown, in its own order. */
  spotsSubtotal: Money;
  feesTotal: Money;
  gstAmount: Money;
  discount: Money;
  total: Money;
  budget: Money | null;
  /** Negative when the cart has outrun the budget. */
  budgetRemaining: Money | null;
  days: number;
  creativesUploaded: number;
  creativesExpected: number;
  missing: MissingAnswer[];
  /**
   * Lot D (Q120): what stands between a paid campaign and its launch without
   * blocking the payment — artwork with a file that ops have not approved.
   * Empty means nothing is outstanding.
   */
  outstanding: { code: 'CREATIVES_NOT_APPROVED'; label: string; creativeIds: string[] }[];
  /**
   * Lot D (Q123): the agreements this booking needs, and where each stands.
   * `current` is what authorisation checks: accepted on the version live now.
   */
  agreements: AgreementStanding[];
  /**
   * The trigger the brief asked for, and the fact that nothing enforces it.
   * The review screen is the last chance to say so before money moves.
   */
  triggers: TriggerPlan;
  /**
   * Spots with no slot left over the flight — taken while this one was being
   * built. Lot G (Q116/136): a spot with a loop clashes only when every slot
   * is held, so `reason` says what the screen should: no slot left, not
   * "booked".
   */
  clashes: { spotId: string; listingId: string; title: string; reason: 'NO_SLOT_LEFT' }[];
};

const sizeOf = (listing: { widthFt: unknown; heightFt: unknown }): string | null =>
  listing.widthFt && listing.heightFt
    ? `${new Decimal(listing.widthFt as never).toFixed(0)}×${new Decimal(listing.heightFt as never).toFixed(0)} ft`
    : null;

/**
 * Lot B (Q38): what the quote resolved for one spot, kept beside the review
 * rather than on it. The review is what the advertiser reads, and the
 * advertiser is not meant to see ADX's take at all.
 */
type SpotCommission = { commissionPct: Money; commissionSource: string };

/**
 * Prices the cart without changing anything.
 *
 * Called on the review screen, and again inside authorization — deliberately
 * recomputed there rather than trusting what the client last saw, because the
 * number that gets held has to be the number the server just worked out.
 */
export async function reviewCampaign(campaign: CampaignAggregate): Promise<CampaignReview> {
  return (await priceCampaign(campaign)).review;
}

/**
 * The review, plus the commission each spot's quote resolved — one quote per
 * spot, and the authorisation stamps from the same call that priced it, so
 * the take on the spot is the take the invoice was computed under.
 */
async function priceCampaign(
  campaign: CampaignAggregate
): Promise<{ review: CampaignReview; commissions: Map<string, SpotCommission> }> {
  const days = flightDays(campaign.startDate, campaign.endDate);

  const lines: CampaignLine[] = [];
  const commissions = new Map<string, SpotCommission>();
  let spotsSubtotal = new Decimal(0);
  let feesTotal = new Decimal(0);
  let gstAmount = new Decimal(0);

  for (const spot of campaign.spots) {
    const bill = await revenueQuote({
      listingId: spot.listingId,
      days: spot.days,
      spots: spot.quantity,
      ratePerDay: money(spot.ratePerDay),
      ...(campaign.startDate ? { at: campaign.startDate } : {}),
    });
    commissions.set(spot.id, {
      commissionPct: bill.publisher.commissionPct,
      commissionSource: bill.publisher.commissionSource,
    });

    const media = bill.lines.find((line) => line.kind === 'MEDIA');
    const fees = bill.lines
      .filter((line) => line.kind !== 'MEDIA')
      .map((line) => ({ label: line.label, amount: line.taxableValue }));

    const mediaValue = new Decimal(media?.taxableValue ?? spot.lineTotal);
    const feeValue = fees.reduce((sum, fee) => sum.plus(new Decimal(fee.amount)), new Decimal(0));

    spotsSubtotal = spotsSubtotal.plus(mediaValue);
    feesTotal = feesTotal.plus(feeValue);
    gstAmount = gstAmount.plus(new Decimal(bill.gstAmount));

    lines.push({
      spotId: spot.id,
      listingId: spot.listingId,
      title: spot.listing.title,
      city: spot.listing.city,
      photoUrl: spot.listing.photos[0]?.url ?? null,
      mediaTypeName: spot.listing.mediaType?.name ?? null,
      size: sizeOf(spot.listing),
      ratePerDay: money(spot.ratePerDay),
      days: spot.days,
      quantity: spot.quantity,
      lineTotal: money(mediaValue),
      fees,
      gst: bill.gstAmount,
      gross: bill.grossTotal,
    });
  }

  const discount = campaign.discount ? new Decimal(campaign.discount) : ZERO;
  const total = spotsSubtotal.plus(feesTotal).plus(gstAmount).minus(discount);
  const budget = campaign.budget ? new Decimal(campaign.budget) : null;

  // Artwork is expected per spot on the paths that produce a file, and once for
  // the campaign on the paths that produce a brief.
  const perSpot =
    campaign.creativePath === 'STATIC_IMAGES' || campaign.creativePath === 'VIDEO_OR_MOTION';
  const creativesExpected = perSpot ? campaign.spots.length : campaign.creativePath ? 1 : 0;
  // Lot D (Q44): a re-upload supersedes the row it replaces; count slots, not rows.
  const creativesUploaded = currentCreatives(campaign.creatives).filter((creative) => creative.fileUrl).length;
  const unapproved = outstandingCreatives(campaign.creatives);

  // Lot G (Q116/136): a clash is a spot with too few slots left over the
  // flight — the orders running on it plus other campaigns' live
  // reservations (Lot C, Q88) against its `slotsTotal`; this campaign's own
  // never count. G10: each spot asks for its `quantity`.
  const clashingIds =
    campaign.startDate && campaign.endDate && campaign.spots.length > 0
      ? await repository.clashingListingIds(
          campaign.spots.map((spot) => ({ listingId: spot.listingId, quantity: spot.quantity })),
          campaign.startDate,
          campaign.endDate,
          { excludeCampaignId: campaign.id }
        )
      : [];

  // Lot D (Q123): the insertion order, on the version live now. Asked here so
  // the review screen can show the gate before the advertiser reaches it.
  const insertionOrder = await transactionAcceptance('INSERTION_ORDER', { campaignId: campaign.id });
  const missing = missingAnswers(campaign);
  if (!insertionOrder.current) {
    missing.push({
      step: 'AUTHORIZE',
      field: 'AGREEMENT_REQUIRED',
      label: insertionOrder.accepted
        ? `Accept the current insertion order (version ${insertionOrder.currentVersion ?? '—'})`
        : 'Accept the insertion order',
    });
  }

  const review: CampaignReview = {
    campaignId: campaign.id,
    reference: campaign.reference,
    status: campaign.status,
    lines,
    spotsSubtotal: money(spotsSubtotal),
    feesTotal: money(feesTotal),
    gstAmount: money(gstAmount),
    discount: money(discount),
    total: money(total.lessThan(0) ? ZERO : total),
    budget: budget ? money(budget) : null,
    budgetRemaining: budget ? money(budget.minus(spotsSubtotal)) : null,
    days,
    creativesUploaded,
    creativesExpected,
    missing,
    outstanding:
      unapproved.length > 0
        ? [
            {
              code: 'CREATIVES_NOT_APPROVED',
              label: `${unapproved.length} artwork${unapproved.length === 1 ? '' : 's'} awaiting ADX approval — nothing prints or goes live until then`,
              creativeIds: unapproved.map((creative) => creative.id),
            },
          ]
        : [],
    agreements: [insertionOrder],
    triggers: triggerPlan(campaign),
    clashes: campaign.spots
      .filter(
        (spot) => spot.status === 'RESERVED' && clashingIds.includes(spot.listingId)
      )
      .map((spot) => ({ spotId: spot.id, listingId: spot.listingId, title: spot.listing.title, reason: 'NO_SLOT_LEFT' as const })),
  };
  return { review, commissions };
}

/* ------------------------------------------------------------------ */
/* The cart                                                            */
/* ------------------------------------------------------------------ */

/**
 * Replaces what is in the cart.
 *
 * Rates are read off the listing here rather than taken from the client: the
 * matcher showed a price, but the price that binds is the one the server reads
 * at the moment the spot goes in. Booked spots are untouchable — they have
 * orders behind them.
 */
export async function setCart(
  campaign: CampaignAggregate,
  items: { listingId: string; quantity?: number; matchScore?: number | null }[]
): Promise<CampaignAggregate> {
  if (!campaign.startDate || !campaign.endDate) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Set the flight dates before choosing spots.');
  }
  const days = flightDays(campaign.startDate, campaign.endDate);

  const wanted = [...new Set(items.map((item) => item.listingId))];
  const listings = await repository.listingsByIds(wanted);
  const byId = new Map(listings.map((listing) => [listing.id, listing]));

  const booked = new Set(
    campaign.spots.filter((spot) => spot.status !== 'RESERVED').map((spot) => spot.listingId)
  );

  // Q31: the marketplace floor sits under every listing's own minimum. A
  // publisher may ask for more than the platform does; none may take a
  // shorter booking than ADX sells.
  const platformMinDays = (await getPlatformSettings()).marketplace.minBookingDays;

  const spots: NewSpot[] = [];
  for (const item of items) {
    if (booked.has(item.listingId)) continue; // already paid for; not editable here
    const listing = byId.get(item.listingId);
    if (!listing) throw new ApiError(404, 'NOT_FOUND', `Listing ${item.listingId} not found`);
    if (!listing.ratePerDay) {
      throw new ApiError(409, 'CONFLICT', `${listing.title} has no rate and cannot be booked.`);
    }
    const minDays = Math.max(listing.minBookingDays ?? 0, platformMinDays);
    if (days < minDays) {
      throw new ApiError(
        409,
        'CONFLICT',
        `${listing.title} takes bookings of ${minDays} days or more; this flight is ${days}.`
      );
    }

    const quantity = Math.max(1, Math.floor(item.quantity ?? 1));
    const rate = new Decimal(listing.ratePerDay);
    spots.push({
      campaignId: campaign.id,
      listingId: listing.id,
      matchScore: item.matchScore ?? null,
      ratePerDay: rate,
      days,
      quantity,
      lineTotal: rate.times(days).times(quantity),
      startDate: campaign.startDate,
      endDate: campaign.endDate,
    });
  }

  await repository.replaceSpots(campaign.id, spots);
  return (await repository.findCampaign(campaign.id))!;
}

/* ------------------------------------------------------------------ */
/* Authorization and launch                                            */
/* ------------------------------------------------------------------ */

export type AuthorizeResult = {
  campaign: CampaignAggregate;
  review: CampaignReview;
  /** Orders that could not be raised, with the reason. Never silent. */
  failedSpots: { spotId: string; title: string; reason: string }[];
  /**
   * Lot B (Q1): the CAMPAIGN_ASSIST recorded for the agent who ran the wizard,
   * or null — self-serve, already recorded, or unpriceable.
   */
  incentive: { id: string; amount: Money } | null;
  /**
   * E6: the invoice `invoices` issued inside the authorisation through the
   * port, or null — unregistered, or the issue failed and the desk's
   * POST /finance/invoices/issue catches up.
   */
  invoice: IssuedInvoiceSummary | null;
};

/**
 * Lot B (Q1): the assist, paid once per campaign.
 *
 * Recorded at authorisation — the moment the booking is real — for the agent
 * on the campaign, at their tier, PENDING_VERIFICATION for finance. Keyed on
 * `Campaign.assistIncentiveId`: a campaign that already carries one is not
 * paid again, and the id is written back before this returns so a retried
 * authorise finds it. Never fails the launch; the money and the orders are
 * already committed by the time this runs.
 */
async function recordCampaignAssist(
  campaign: Pick<CampaignAggregate, 'id' | 'reference' | 'advertiserId' | 'agentId' | 'assistIncentiveId'>,
  now: Date
): Promise<AuthorizeResult['incentive']> {
  if (!campaign.agentId || campaign.assistIncentiveId) return null;
  try {
    const tier = (await findAgentTier(campaign.agentId)) ?? '*';
    const incentive = await recordIncentive(
      {
        agentId: campaign.agentId,
        event: 'CAMPAIGN_ASSIST',
        tier,
        advertiserId: campaign.advertiserId,
        note: campaign.reference,
        // Lot F: the agent's INCENTIVE_RECORDED notice opens the campaign.
        notice: { campaignId: campaign.id, partyName: campaign.reference },
      },
      now
    );
    await repository.updateCampaign(campaign.id, { assistIncentiveId: incentive.id });
    return { id: incentive.id, amount: money(incentive.amount) };
  } catch (err) {
    logger.warn('Campaign assist was not recorded', { campaignId: campaign.id, agentId: campaign.agentId, err });
    return null;
  }
}

/**
 * Takes the money and books the inventory.
 *
 * Idempotent at the top: a campaign that already has a hold is not charged
 * twice, because a phone on a bad connection will send this request twice and
 * the second one must not cost anybody money.
 */
/**
 * What stands between a campaign and its authorisation, in the order the
 * header lists them. Shared by the wallet authorise, the gateway's payment
 * quote (Lot C) and the send-to-pay, so all three refuse the same things.
 *
 * `agreement: false` skips the insertion-order gate: sending a campaign to
 * the advertiser to pay happens before they have accepted it, and the
 * acceptance is their own click, never ops'.
 */
function assertAuthorisable(
  campaign: Pick<CampaignAggregate, 'status' | 'walletHoldId'>,
  review: CampaignReview,
  options: { agreement: boolean } = { agreement: true }
): void {
  if (campaign.status !== 'DRAFT' && campaign.status !== 'PENDING_PAYMENT') {
    throw new ApiError(409, 'CONFLICT', 'This campaign has already been authorized.');
  }
  if (campaign.walletHoldId) {
    throw new ApiError(409, 'CONFLICT', 'Payment for this campaign is already authorized.');
  }

  const brief = review.missing.filter((item) => item.field !== 'AGREEMENT_REQUIRED');
  if (brief.length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `The campaign is not finished: ${brief.map((item) => item.label).join(', ')}.`,
      { missing: review.missing }
    );
  }
  // Lot D (Q123): the insertion order, accepted on the version live now. Its
  // own code, because the app sends the advertiser to the agreement screen on
  // it rather than back into the wizard.
  const insertionOrder = review.agreements.find((item) => item.kind === 'INSERTION_ORDER');
  if (options.agreement && !insertionOrder?.current) {
    throw new ApiError(
      403,
      'AGREEMENT_REQUIRED',
      insertionOrder?.accepted
        ? 'The insertion order has changed since it was accepted. Accept the current version to authorise the campaign.'
        : 'Accept the insertion order to authorise the campaign.',
      { missing: review.missing, agreements: review.agreements }
    );
  }
  if (review.clashes.length > 0) {
    throw new ApiError(
      409,
      'CONFLICT',
      `${review.clashes.map((clash) => clash.title).join(', ')} ${review.clashes.length === 1 ? 'has' : 'have'} no slot left for these dates — taken while this campaign was being built. Remove them and pick again.`,
      { clashes: review.clashes }
    );
  }
  if (new Decimal(review.total).lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A campaign has to cost something to be booked.');
  }
}

export async function authorizeCampaign(
  campaign: CampaignAggregate,
  now = new Date()
): Promise<AuthorizeResult> {
  const { review, commissions } = await priceCampaign(campaign);
  assertAuthorisable(campaign, review);

  // Profile, agreement and funds — checked before anything is written, so a
  // campaign that cannot be paid for fails while somebody is still looking at it.
  const eligibility = await assertCanBook(campaign.advertiserId, review.total);

  // QR-16 (the owner, 17 Sep 2026): an unverified advertiser may book and pay,
  // but the campaign does not RUN until KYC is verified. One due today stays
  // SCHEDULED with its hold uncaptured; the lifecycle tick launches it once
  // the record clears. The advertiser is told what stands between them and
  // the launch, and the detail read says so beside the campaign.
  const launchHeld = (eligibility?.launchBlockedBy ?? []).includes('KYC');

  const { holdId } = await holdForCampaign(campaign.advertiserId, campaign.id, review.total);

  const startsToday = !launchHeld && (campaign.startDate ? campaign.startDate <= now : false);

  await repository.updateCampaign(campaign.id, {
    status: startsToday ? 'LIVE' : 'SCHEDULED',
    spotsSubtotal: new Decimal(review.spotsSubtotal),
    feesTotal: new Decimal(review.feesTotal),
    gstAmount: new Decimal(review.gstAmount),
    discount: new Decimal(review.discount),
    total: new Decimal(review.total),
    walletHoldId: holdId,
    paidAt: now,
    launchedAt: startsToday ? now : null,
    step: 17,
  });

  /*
   * A live campaign's money is spent on the day it starts. A scheduled one keeps
   * the hold until then, which is what a hold is for — the advertiser's balance
   * shows it committed without it having left.
   */
  if (startsToday) await captureCampaignHold(holdId);
  if (launchHeld) await tellAdvertiserToVerify(campaign, now);

  // Lot D (Q139): the tracking codes, before the order loop — the artwork
  // embeds them, and the print shop needs the artwork. Idempotent.
  await issueTrackingCodes(campaign.id);

  // Lot B (Q13): the document for the money just held — PAID when the hold was
  // captured, ISSUED while it waits. Through the port, best-effort: the hold
  // stands whether or not a number could be allocated (see invoicing.port.ts).
  const invoice = await campaignInvoicing.issueForCampaign(campaign.id, campaign.createdByUserId);

  const failedSpots: AuthorizeResult['failedSpots'] = [];

  for (const spot of campaign.spots) {
    if (spot.status !== 'RESERVED') continue;
    // Lot B (Q38): the commission resolved by the quote that priced this
    // spot, stamped with the booking so the accrual charges what was quoted
    // and a rate change next month never re-rates a running flight.
    const commission = commissions.get(spot.id);
    try {
      const order = await placeOrder({
        advertiserId: campaign.advertiserId,
        listingId: spot.listingId,
        campaignName: campaign.name,
        budget: Number(spot.lineTotal),
        ...(spot.startDate ? { startDate: spot.startDate } : {}),
        ...(spot.endDate ? { endDate: spot.endDate } : {}),
        notes: `Campaign ${campaign.reference}`,
        // Lot G (Q116/136): placement counts the spot's slots; this
        // campaign's own reservation on it is not one of the holds. G10:
        // the spot takes `quantity` of them.
        forCampaignId: campaign.id,
        quantity: spot.quantity,
      });
      await repository.updateSpot(spot.id, {
        status: startsToday ? 'LIVE' : 'BOOKED',
        orderId: order.id,
        ...(commission
          ? {
              commissionPct: new Decimal(commission.commissionPct),
              commissionSource: commission.commissionSource,
            }
          : {}),
      });
    } catch (cause) {
      // The listing went unavailable between review and launch. The spot stays
      // reserved and is reported, rather than the whole campaign failing after
      // the money was taken.
      failedSpots.push({
        spotId: spot.id,
        title: spot.listing.title,
        reason:
          cause instanceof Error && cause.message === 'LISTING_NOT_AVAILABLE'
            ? 'The publisher took this site off the market'
            : cause instanceof Error
              ? cause.message
              : 'Could not raise an order',
      });
    }
  }

  const incentive = await recordCampaignAssist(campaign, now);

  const refreshed = (await repository.findCampaign(campaign.id))!;
  return { campaign: refreshed, review: await reviewCampaign(refreshed), failedSpots, incentive, invoice };
}

/* ------------------------------------------------------------------ */
/* Lot C (Q88/Q110): sent to pay, paid by gateway, authorised on behalf  */
/* ------------------------------------------------------------------ */

/** How long a prepared campaign holds its spots for the advertiser to pay. */
export const RESERVATION_HOURS = 24;

/**
 * Ops (or the campaign's agent) hand a finished brief to the advertiser to
 * pay. The campaign goes PENDING_PAYMENT, every RESERVED spot is held for 24
 * hours — the clash check reads that hold as booked — and the advertiser is
 * told. No money moves: the authorise, from the wallet or through a gateway,
 * is still the advertiser's own act (or ops' on their behalf, below).
 *
 * The insertion order is deliberately not required here: it is the
 * advertiser's click, and sending them the campaign is how they get to it.
 * A re-send refreshes the hold.
 */
export async function submitForPayment(
  campaign: CampaignAggregate,
  actor: Actor,
  now = new Date()
): Promise<{ campaign: CampaignAggregate; review: CampaignReview; reservedUntil: Date }> {
  if (!actor.isAdmin && !(actor.agentId && campaign.agentId === actor.agentId)) {
    throw new ApiError(403, 'FORBIDDEN', "Only ADX or the campaign's agent can send it to the advertiser to pay.");
  }
  const review = await reviewCampaign(campaign);
  assertAuthorisable(campaign, review, { agreement: false });

  const reservedUntil = new Date(now.getTime() + RESERVATION_HOURS * 60 * 60 * 1000);
  // G10: the hold counts again under the listing locks; a spot the slots
  // left between the review and this write is the same 409 the review gives.
  // Held before the status moves, so a refused send leaves the campaign as
  // it was — the hold writes nothing on a clash, and neither does this.
  try {
    await repository.holdReservations(campaign.id, reservedUntil, now);
  } catch (err) {
    if (!(err instanceof SlotClashError)) throw err;
    const clashes = campaign.spots
      .filter((spot) => spot.status === 'RESERVED' && err.listingIds.includes(spot.listingId))
      .map((spot) => ({ spotId: spot.id, listingId: spot.listingId, title: spot.listing.title, reason: 'NO_SLOT_LEFT' as const }));
    throw new ApiError(
      409,
      'CONFLICT',
      `${clashes.map((clash) => clash.title).join(', ')} ${clashes.length === 1 ? 'has' : 'have'} no slot left for these dates — taken while this campaign was being sent. Remove them and pick again.`,
      { clashes },
    );
  }
  await repository.updateCampaign(campaign.id, {
    status: 'PENDING_PAYMENT',
    submittedForPaymentAt: now,
    submittedByUserId: actor.userId,
    spotsSubtotal: new Decimal(review.spotsSubtotal),
    feesTotal: new Decimal(review.feesTotal),
    gstAmount: new Decimal(review.gstAmount),
    discount: new Decimal(review.discount),
    total: new Decimal(review.total),
  });

  const context = await repository.advertiserContext(campaign.advertiserId);
  if (context?.userId) {
    try {
      await createNotification({
        userId: context.userId,
        type: 'BOOKING',
        title: 'Your campaign is ready to pay',
        subtitle: campaign.name,
        message: `${campaign.reference} is prepared: ${review.lines.length} spot${review.lines.length === 1 ? '' : 's'} for INR ${review.total}. The spots are held for you for ${RESERVATION_HOURS} hours.`,
        suggestedAction: 'Review and pay',
        relatedId: campaign.id,
        relatedType: 'CAMPAIGN',
      });
    } catch (err) {
      logger.warn('Could not tell the advertiser their campaign is ready to pay', { campaignId: campaign.id, err });
    }
  }

  const refreshed = (await repository.findCampaign(campaign.id))!;
  return { campaign: refreshed, review, reservedUntil };
}

/**
 * The lifecycle job's sweep: a reservation that has lapsed goes back to a
 * plain RESERVED spot — still in the cart, no longer blocking anyone else.
 */
export async function expireSpotReservations(now = new Date()): Promise<{ cleared: number }> {
  return { cleared: await repository.clearExpiredReservations(now) };
}

/** What a gateway has to collect for a campaign, and for whom (Lot C, Q110). */
export type CampaignPaymentQuote = {
  campaignId: string;
  reference: string;
  name: string;
  advertiserId: string;
  status: CampaignStatus;
  total: Money;
  agreements: AgreementStanding[];
};

/**
 * For `payments`: the campaign priced and checked exactly as the authorise
 * would check it, before a gateway order is created — so the money is never
 * taken for a campaign that could not then be authorised.
 */
export async function campaignPaymentQuote(campaignId: string, actor: Actor): Promise<CampaignPaymentQuote> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  assertMayAct(campaign, actor);
  const review = await reviewCampaign(campaign);
  assertAuthorisable(campaign, review);
  return {
    campaignId: campaign.id,
    reference: campaign.reference,
    name: campaign.name,
    advertiserId: campaign.advertiserId,
    status: campaign.status,
    total: review.total,
    agreements: review.agreements,
  };
}

/**
 * For `payments`: the gateway captured, the wallet was credited, and the
 * campaign is authorised out of that balance — the same authorise the
 * wallet path runs. A campaign already authorised answers 409 like any
 * other double press, which the caller treats as settled.
 */
export async function authorizeCampaignById(campaignId: string, now = new Date()): Promise<AuthorizeResult> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  return authorizeCampaign(campaign, now);
}

/**
 * Ops authorise on the advertiser's behalf (Q88), out of the advertiser's
 * wallet — a recorded bank transfer credits spendable balance (Q118), and
 * this is how that balance becomes a booking without the advertiser's
 * phone. Two guards on top of the ordinary authorise: the campaign
 * reference typed back, and at or above `finance.opsAuthoriseThreshold` a
 * second admin named, who is not the first. The controller audits it
 * CAMPAIGN_AUTHORIZED_ON_BEHALF.
 */
export async function authorizeOnBehalf(
  campaign: CampaignAggregate,
  input: { confirm?: string | undefined; approvedByUserId?: string | undefined },
  actor: Actor,
  now = new Date()
): Promise<AuthorizeResult & { approvedByUserId: string | null }> {
  if (!actor.isAdmin) throw new ApiError(403, 'FORBIDDEN', "Only ADX authorises on an advertiser's behalf.");
  if ((input.confirm ?? '').trim() !== campaign.reference) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Type the campaign reference (${campaign.reference}) to confirm authorising on the advertiser's behalf.`,
      { confirm: campaign.reference }
    );
  }

  const review = await reviewCampaign(campaign);
  const threshold = new Decimal((await getPlatformSettings()).finance.opsAuthoriseThreshold);
  let approvedByUserId: string | null = null;
  if (new Decimal(review.total).greaterThanOrEqualTo(threshold)) {
    const approver = input.approvedByUserId?.trim();
    if (!approver || approver === actor.userId || !(await listAdminUserIds()).includes(approver)) {
      throw new ApiError(
        409,
        'FOUR_EYES',
        `A campaign of INR ${review.total} is at or above the INR ${threshold.toFixed(2)} threshold and needs a second admin's approval to authorise on the advertiser's behalf.`,
        { total: review.total, threshold: threshold.toFixed(2) }
      );
    }
    approvedByUserId = approver;
  }

  const result = await authorizeCampaign(campaign, now);
  return { ...result, approvedByUserId };
}

export type CancelOutcome = {
  released: boolean;
  refundNeeded: boolean;
  /**
   * Lot B (Q41): the PENDING CampaignRefund recorded for finance when the
   * money had already been captured and unused days remain. Null when the
   * hold was merely released, or nothing was left unused.
   */
  campaignRefundId: string | null;
  /** The unused value, as recorded. "0.00" when nothing is owed. */
  refundAmount: Money;
};

/**
 * Cancels a campaign, and gives back whatever has not been spent.
 *
 * A scheduled campaign's hold is released — the money never left. A live one
 * has already been captured, and a refund is a decision with a person behind
 * it: the unused days are valued and recorded as a PENDING `CampaignRefund`
 * for the refund desk (`/finance/campaign-refunds`), never credited here.
 *
 * `byUserId` is who asked. A cancel with no person behind it — a suspension
 * sweep — is recorded as the system's, and the desk still needs a second
 * person to release it.
 */
export async function cancelCampaign(
  campaign: CampaignAggregate,
  reason: string,
  now = new Date(),
  byUserId: string | null = null
): Promise<CancelOutcome> {
  if (campaign.status === 'CANCELLED') {
    const existing = await repository.findCampaignRefundByCampaign(campaign.id);
    return {
      released: false,
      refundNeeded: false,
      campaignRefundId: existing?.id ?? null,
      refundAmount: existing ? money(existing.amount) : money(0),
    };
  }
  if (campaign.status === 'COMPLETED') {
    throw new ApiError(409, 'CONFLICT', 'A finished campaign cannot be cancelled.');
  }

  let released = false;
  let refundNeeded = false;
  let campaignRefundId: string | null = null;
  let refundAmount = money(0);

  if (campaign.walletHoldId) {
    if (campaign.status === 'SCHEDULED') {
      await releaseCampaignHold(campaign.walletHoldId);
      released = true;
    } else {
      // Captured already. What is unused — whole undelivered days, today
      // included — is what the desk decides on; measured before the spots
      // are marked CANCELLED below.
      refundNeeded = true;
      const live = campaign.spots.filter((spot) => spot.status !== 'CANCELLED');
      const days = unusedDays(campaign.startDate, campaign.endDate, now);
      refundAmount = money(sumUnused(live, days));
      const refund = await openCampaignRefund({
        campaignId: campaign.id,
        amount: refundAmount,
        reason,
        requestedByUserId: byUserId ?? 'system',
      });
      campaignRefundId = refund?.id ?? null;
    }
  }

  for (const spot of campaign.spots) {
    if (spot.status === 'CANCELLED') continue;
    await repository.updateSpot(spot.id, { status: 'CANCELLED' });
  }

  await repository.updateCampaign(campaign.id, {
    status: 'CANCELLED',
    cancelledAt: now,
    cancellationReason: reason,
  });

  // Lot B (Q13): an invoiced booking that is cancelled is reversed on paper
  // too — a credit note against the invoice, which goes VOID. After capture
  // the note stands beside the refund the desk decides on; before capture the
  // money never left, and an issued invoice still cannot be deleted, only
  // credited. Best-effort through the port, like the issue itself.
  if (released || refundNeeded) {
    await campaignInvoicing.creditNoteForCampaign(campaign.id, reason, byUserId);
  }

  return { released, refundNeeded, campaignRefundId, refundAmount };
}

/* ------------------------------------------------------------------ */
/* Lot A: what a suspension has to give back                           */
/* ------------------------------------------------------------------ */

/**
 * Whole days of a flight that have not been delivered yet, counting today.
 *
 * Today counts as unused because a suspension stops the work now: a spot that
 * comes down this morning did not run today. A flight that has not started is
 * unused end to end; one that has finished owes nothing.
 */
export function unusedDays(start: Date | null, end: Date | null, now: Date): number {
  if (!start || !end) return 0;
  if (now < start) return flightDays(start, end);
  if (now > end) return 0;
  return flightDays(now, end);
}

/** What a suspension owes back on one campaign, for the refund desk to decide. */
export type CampaignRefund = {
  campaignId: string;
  reference: string;
  advertiserId: string;
  /** Unused days x rate x quantity, summed over the spots that stopped. */
  amount: Money;
  spotIds: string[];
  /** True when the money has already been captured, so a release cannot give it back. */
  refundNeeded: boolean;
};

const sumUnused = (
  spots: { ratePerDay: Decimal | string; quantity: number }[],
  days: number
): Decimal =>
  spots.reduce(
    (total, spot) => total.plus(new Decimal(spot.ratePerDay).times(spot.quantity).times(days)),
    new Decimal(0)
  );

/**
 * Lot A STOP_OPEN_WORK on a listing or a publisher: the orders on those spots
 * are cancelled through the order lane, and this is the campaign side of it —
 * each affected spot is marked CANCELLED and the unused days are added up per
 * campaign, so the caller can raise ONE refund request for each.
 *
 * No wallet is touched here. A refund is a two-person decision by design, and
 * this only says what it would be for.
 */
export async function cancelSpotsForOrders(
  orderIds: string[],
  now = new Date()
): Promise<CampaignRefund[]> {
  const spots = await repository.findSpotsByOrderIds(orderIds);
  const byCampaign = new Map<string, CampaignRefund & { total: Decimal }>();

  for (const spot of spots) {
    if (spot.status !== 'CANCELLED') await repository.updateSpot(spot.id, { status: 'CANCELLED' });

    const days = unusedDays(
      spot.startDate ?? spot.campaign.startDate,
      spot.endDate ?? spot.campaign.endDate,
      now
    );
    const value = sumUnused([spot], days);
    const seen = byCampaign.get(spot.campaign.id);
    if (seen) {
      seen.total = seen.total.plus(value);
      seen.spotIds.push(spot.id);
      continue;
    }
    byCampaign.set(spot.campaign.id, {
      campaignId: spot.campaign.id,
      reference: spot.campaign.reference,
      advertiserId: spot.campaign.advertiserId,
      amount: money(value),
      spotIds: [spot.id],
      // Scheduled money is still held and is released with the campaign; a
      // live campaign's has been captured and only a refund can return it.
      refundNeeded: Boolean(spot.campaign.walletHoldId) && spot.campaign.status !== 'SCHEDULED',
      total: value,
    });
  }

  return [...byCampaign.values()].map(({ total, ...row }) => ({ ...row, amount: money(total) }));
}

/**
 * Lot A STOP_OPEN_WORK on an advertiser: their scheduled and live campaigns
 * are cancelled through the ordinary cancel — there is no "paused" state in
 * the schema and inventing one in code would leave the orders running — and
 * the unused days come back as one refund figure per campaign.
 */
/* ------------------------------------------------------------------ */
/* Lot B (Q13): what an invoice itemises                               */
/* ------------------------------------------------------------------ */

/**
 * The booking as `invoices` reads it: the snapshot the advertiser authorised
 * — every spot at the rate, days and quantity that were held — and the
 * totals stamped at authorisation. Never the review re-run: an invoice is a
 * record of what was charged, and a listing repriced since must not move it.
 */
export type CampaignInvoiceSnapshot = {
  id: string;
  reference: string;
  name: string;
  advertiserId: string;
  createdByUserId: string;
  status: CampaignStatus;
  startDate: Date | null;
  endDate: Date | null;
  spotsSubtotal: Money | null;
  feesTotal: Money | null;
  gstAmount: Money | null;
  discount: Money;
  total: Money | null;
  walletHoldId: string | null;
  paidAt: Date | null;
  launchedAt: Date | null;
  spots: {
    id: string;
    listingId: string;
    title: string;
    city: string | null;
    status: string;
    ratePerDay: Money;
    days: number;
    quantity: number;
    lineTotal: Money;
  }[];
};

export async function findCampaignForInvoice(campaignId: string): Promise<CampaignInvoiceSnapshot | null> {
  const campaign = await repository.findCampaign(campaignId);
  if (!campaign) return null;
  return {
    id: campaign.id,
    reference: campaign.reference,
    name: campaign.name,
    advertiserId: campaign.advertiserId,
    createdByUserId: campaign.createdByUserId,
    status: campaign.status,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    spotsSubtotal: campaign.spotsSubtotal === null ? null : money(campaign.spotsSubtotal),
    feesTotal: campaign.feesTotal === null ? null : money(campaign.feesTotal),
    gstAmount: campaign.gstAmount === null ? null : money(campaign.gstAmount),
    discount: money(campaign.discount ?? 0),
    total: campaign.total === null ? null : money(campaign.total),
    walletHoldId: campaign.walletHoldId,
    paidAt: campaign.paidAt,
    launchedAt: campaign.launchedAt,
    spots: campaign.spots.map((spot) => ({
      id: spot.id,
      listingId: spot.listingId,
      title: spot.listing.title,
      city: spot.listing.city,
      status: spot.status,
      ratePerDay: money(spot.ratePerDay),
      days: spot.days,
      quantity: spot.quantity,
      lineTotal: money(spot.lineTotal),
    })),
  };
}

/**
 * The campaigns still in flight for one advertiser — SCHEDULED or LIVE.
 *
 * Read by `account-lifecycle` for Lot A's closure review (Q21), which has to
 * refuse a closure while money is committed to inventory. The same filter
 * `cancelAdvertiserCampaigns` acts on, so the review and the act cannot drift.
 */
export async function listOpenCampaignsForAdvertiser(
  advertiserId: string
): Promise<{ id: string; reference: string; status: CampaignStatus }[]> {
  const rows = await repository.listCampaigns({
    advertiserId,
    status: ['SCHEDULED', 'LIVE'],
    limit: 200,
  });
  return rows.map((row) => ({ id: row.id, reference: row.reference, status: row.status }));
}

export async function cancelAdvertiserCampaigns(
  advertiserId: string,
  reason: string,
  now = new Date()
): Promise<CampaignRefund[]> {
  const rows = await repository.listCampaigns({
    advertiserId,
    status: ['SCHEDULED', 'LIVE'],
    limit: 200,
  });

  const refunds: CampaignRefund[] = [];
  for (const row of rows) {
    const campaign = await repository.findCampaign(row.id);
    if (!campaign) continue;

    // Measured before the cancel, which marks every spot CANCELLED.
    const live = campaign.spots.filter((spot) => spot.status !== 'CANCELLED');
    const days = unusedDays(campaign.startDate, campaign.endDate, now);
    const amount = sumUnused(live, days);

    const { refundNeeded } = await cancelCampaign(campaign, reason, now);
    refunds.push({
      campaignId: campaign.id,
      reference: campaign.reference,
      advertiserId,
      amount: money(amount),
      spotIds: live.map((spot) => spot.id),
      refundNeeded,
    });
  }
  return refunds;
}

/**
 * Moves campaigns across the dates they were booked for.
 *
 * Scheduled campaigns whose start has arrived go live and their hold is
 * captured; live campaigns whose end has passed complete. Run by the scheduler,
 * idempotent, and safe to run twice in the same minute.
 *
 * One campaign at a time, and one that fails does not stop the rest: since
 * Lot B (B3a) the capture is refused for a frozen advertiser (WALLET_FROZEN),
 * and one suspended advertiser must not hold every other campaign's start
 * back. The campaign stays SCHEDULED and is offered again next tick; the
 * refusal is logged with the campaign for ops to see.
 */
export async function runCampaignTransitions(now = new Date()): Promise<{
  wentLive: number;
  completed: number;
  skipped: number;
  /** Lot D (Q120): due to start, left SCHEDULED because artwork is not approved. */
  blocked: number;
  /** QR-16: due to start, left SCHEDULED because the advertiser is not yet verified. */
  awaitingVerification: number;
}> {
  const due = await repository.campaignsToTransition(now);
  let wentLive = 0;
  let completed = 0;
  let skipped = 0;
  let blocked = 0;
  let awaitingVerification = 0;

  for (const row of due) {
    const campaign = await repository.findCampaign(row.id);
    if (!campaign) continue;

    try {
      if (campaign.status === 'SCHEDULED') {
        // QR-16: KYC gates the launch, not the payment. A paid campaign whose
        // advertiser is still unverified stays SCHEDULED — the advertiser is
        // nudged and ops told, once a day each — and goes live on the first
        // tick after the record is verified.
        const context = await repository.advertiserContext(campaign.advertiserId);
        if (context?.kycStatus && context.kycStatus !== 'VERIFIED') {
          awaitingVerification += 1;
          await warnAwaitingVerification(campaign, context.userId, now);
          continue;
        }
        // Lot D (Q120): the hard gate. Paid, due, and not going anywhere
        // until ops approve the artwork. The campaign stays SCHEDULED and is
        // offered again next tick; ops are told once a day per campaign.
        const unapproved = outstandingCreatives(campaign.creatives);
        if (unapproved.length > 0) {
          blocked += 1;
          await warnLaunchBlocked(campaign, unapproved.length, now);
          continue;
        }
        if (campaign.walletHoldId) {
          await captureCampaignHold(campaign.walletHoldId);
          // Lot B (Q13): captured, so the invoice is paid.
          await campaignInvoicing.markCampaignPaid(campaign.id);
        }
        await repository.updateCampaign(campaign.id, { status: 'LIVE', launchedAt: now });
        for (const spot of campaign.spots) {
          if (spot.status === 'BOOKED') await repository.updateSpot(spot.id, { status: 'LIVE' });
        }
        wentLive += 1;
        continue;
      }

      if (campaign.status === 'LIVE') {
        await repository.updateCampaign(campaign.id, { status: 'COMPLETED', completedAt: now });
        for (const spot of campaign.spots) {
          if (spot.status === 'LIVE') await repository.updateSpot(spot.id, { status: 'COMPLETED' });
        }
        completed += 1;
        // Lot D (Q104): the invitation to review. Fire-and-forget — a
        // notification that cannot be written must not stall the tick.
        inviteReviews(campaign).catch(() => {});
      }
    } catch (error) {
      skipped += 1;
      logger.warn('Campaign transition failed; the campaign is left for the next tick', {
        campaignId: campaign.id,
        status: campaign.status,
        reason: String(error),
      });
    }
  }

  return { wentLive, completed, skipped, blocked, awaitingVerification };
}

/** The last UTC day ops were told about each blocked campaign, so a five-minute tick is not a five-minute nag. */
const launchWarnings = new Map<string, string>();

/**
 * QR-16: the campaign is paid and due, and the advertiser's verification is
 * what stands between it and going live. The advertiser hears once a day
 * (a KYC notice, the Digio door behind it) and ops once a day; a campaign
 * authorised today with the verification still open hears at once.
 */
async function warnAwaitingVerification(campaign: CampaignAggregate, userId: string | null, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const key = `${campaign.id}:kyc`;
  if (launchWarnings.get(key) === day) return;
  launchWarnings.set(key, day);
  try {
    await notifyAdmins(
      'Launch held: advertiser not verified',
      `${campaign.reference} (${campaign.name}) is paid and due to go live, and is held until the advertiser's KYC is verified.`,
      campaign.id,
    );
  } catch (err) {
    logger.warn('Could not warn ops of a launch awaiting verification', { campaignId: campaign.id, err });
  }
  if (userId) await nudgeToVerify(campaign, userId);
}

async function tellAdvertiserToVerify(campaign: CampaignAggregate, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  launchWarnings.set(`${campaign.id}:kyc`, day);
  try {
    const context = await repository.advertiserContext(campaign.advertiserId);
    if (context?.userId) await nudgeToVerify(campaign, context.userId);
  } catch (err) {
    logger.warn('Could not tell the advertiser their launch awaits verification', { campaignId: campaign.id, err });
  }
}

async function nudgeToVerify(campaign: CampaignAggregate, userId: string): Promise<void> {
  try {
    await createNotification({
      userId,
      type: 'KYC',
      title: 'Verify to launch your campaign',
      subtitle: campaign.name,
      message: `${campaign.reference} is paid and booked. It goes live once your identity is verified — a few minutes with Digio, or ask your ADX contact to record your documents.`,
      suggestedAction: 'Verify your identity',
      relatedId: campaign.id,
      relatedType: 'CAMPAIGN',
    });
  } catch (err) {
    logger.warn('Could not nudge the advertiser to verify', { campaignId: campaign.id, err });
  }
}

async function warnLaunchBlocked(campaign: CampaignAggregate, count: number, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (launchWarnings.get(campaign.id) === day) return;
  launchWarnings.set(campaign.id, day);
  try {
    await notifyAdmins(
      'Launch blocked: artwork not approved',
      `${campaign.reference} (${campaign.name}) was due to go live and is held: ${count} artwork${count === 1 ? '' : 's'} awaiting approval in the creative review queue.`,
      campaign.id,
    );
  } catch (err) {
    logger.warn('Could not warn ops of a blocked launch', { campaignId: campaign.id, err });
  }
}

/** Only for tests, which run several days through one process. */
export function resetLaunchWarnings(): void {
  launchWarnings.clear();
}

/**
 * Lot D (Q104): a campaign has ended, so its spots are now the advertiser's
 * to review — one per completed spot, through
 * `POST /campaigns/:id/spots/:spotId/review`. Asked once, here, when the
 * flight closes; never before, because nothing has happened to rate.
 */
async function inviteReviews(campaign: CampaignAggregate): Promise<void> {
  const completedSpots = campaign.spots.filter((spot) => spot.status === 'LIVE' || spot.status === 'COMPLETED').length;
  if (completedSpots === 0) return;
  const context = await repository.advertiserContext(campaign.advertiserId);
  if (!context?.userId) return;
  await createNotification({
    userId: context.userId,
    type: 'BOOKING',
    title: 'How were your spots?',
    subtitle: campaign.name,
    message: `${campaign.reference} has ended. Rate the ${completedSpots} spot${completedSpots === 1 ? '' : 's'} it ran on — a star and a line helps the next advertiser choose.`,
    suggestedAction: 'Review your spots',
    relatedId: campaign.id,
    relatedType: 'CAMPAIGN',
  });
}

/** Guards the write paths that only an owner may take. Re-exported for the controller. */
export { assertMayAct };
export type { Actor };
