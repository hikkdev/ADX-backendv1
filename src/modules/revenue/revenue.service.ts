import { ApiError } from '../../shared/errors';
import { Decimal, money } from '../../shared/money';
import type { FeeKind, ListingCategory } from '../../shared/database';
import { prismaRevenueRepository as repository } from './prisma-revenue.repository';
import type { Money, NewCommissionRate, PricingInputs, Rate } from './revenue.repository';

/**
 * What an advertiser pays, and what a publisher keeps.
 *
 * The pricing engine decides what a publisher *lists at*; this decides what
 * happens to that number afterwards. Kept apart on purpose — one is a claim
 * about the market, the other is commercial policy, and a platform that
 * conflates them cannot change its take rate without re-pricing the market.
 *
 * The load-bearing fact: commission comes out of the **publisher's earnings**
 * and is never added to the advertiser's price. So the advertiser sees the
 * publisher's own rate, ADX's take is invisible to them, and ADX shares in any
 * surge the publisher captures automatically — a percentage of a bigger number
 * is bigger, with no separate split to maintain.
 *
 * See docs/revenue-model.md.
 */

const D = Decimal;

export const FALLBACK_GST_PCT = '0.18';

/* ------------------------------------------------------------------ */
/* Commission                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which instrument set the rate, in the order they are tried. Stamped on the
 * `CampaignSpot` at authorisation and copied onto each `EarningAccrual`, so a
 * statement can say why a day carried the take it did.
 */
export type CommissionSource =
  | 'PROMOTIONAL_OVERRIDE'
  | 'SUBSCRIPTION'
  | 'MEDIA_TYPE_SLAB'
  | 'MEDIA_TYPE'
  | 'CATEGORY_RATE'
  | 'PLATFORM_DEFAULT';

export type ResolvedCommission = { ratePct: Rate; source: CommissionSource };

/**
 * Most specific wins: override, subscription, media-type slab, media type,
 * category, platform default.
 *
 * A promotional override beats a subscription deliberately: the override exists
 * to win one particular publisher, usually at a worse rate for ADX than any
 * tier, and losing that negotiation to a tier the publisher also happens to
 * hold would defeat the point of having made it.
 *
 * Lot B (Q10/Q38): the media-type rows sit between the subscription and the
 * category. A row keyed on the pricing engine's own "ad type" is a more
 * specific claim than one keyed on the listing category, and a row with a
 * rental band on top is more specific still. Both lose to a subscription
 * because the publisher paid for that rate.
 *
 * There is no fallback. The platform default is a row ops writes and the seed
 * puts back; when it is missing the quote refuses with
 * `COMMISSION_DEFAULT_MISSING` rather than pricing the marketplace at a number
 * nobody chose.
 */
export function resolveCommission(inputs: PricingInputs): ResolvedCommission {
  const pick = (ratePct: Decimal | string, source: CommissionSource): ResolvedCommission => ({
    ratePct: new D(ratePct).toString(),
    source,
  });
  if (inputs.override) return pick(inputs.override.ratePct, 'PROMOTIONAL_OVERRIDE');
  if (inputs.subscription) return pick(inputs.subscription.ratePct, 'SUBSCRIPTION');
  if (inputs.mediaTypeSlabCommission) {
    return pick(inputs.mediaTypeSlabCommission.ratePct, 'MEDIA_TYPE_SLAB');
  }
  if (inputs.mediaTypeCommission) return pick(inputs.mediaTypeCommission.ratePct, 'MEDIA_TYPE');
  if (inputs.categoryCommission) return pick(inputs.categoryCommission.ratePct, 'CATEGORY_RATE');
  if (inputs.defaultCommission) return pick(inputs.defaultCommission.ratePct, 'PLATFORM_DEFAULT');
  throw new ApiError(
    409,
    'COMMISSION_DEFAULT_MISSING',
    'No active platform-default commission rate is configured. Set one under Finance › Revenue › Commission before pricing.'
  );
}

/**
 * The commission for one listing on one day, with nothing else priced.
 *
 * For the accrual (payouts) on a spot authorised before the stamp existed:
 * the rate is resolved on the day being accrued, keyed on the spot's own rate
 * per unit per day, and the accrual records `RESOLVED_AT_ACCRUAL` beside it.
 * Everything authorised since carries its stamp and never comes here.
 */
export async function commissionForListing(input: {
  listingId: string;
  /** Per unit per day — the spot's snapshotted rate. */
  ratePerDay: Money;
  at: Date;
}): Promise<ResolvedCommission> {
  const listing = await repository.listingForQuote(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  const inputs = await repository.pricingInputs({
    publisherId: listing.publisherId,
    category: listing.category,
    mediaTypeId: listing.mediaTypeId,
    perDayMediaValue: money(input.ratePerDay),
    at: input.at,
  });
  return resolveCommission(inputs);
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export type QuoteLine = {
  kind: 'MEDIA' | FeeKind;
  label: string;
  /** Before tax, after any rate discount that applies to this line. */
  taxableValue: Money;
  gstPct: Rate;
  gstAmount: Money;
  total: Money;
  /** Whether the cart shows this line's amount before checkout. */
  amountShownInCart: boolean;
};

export type Quote = {
  listingId: string;
  days: number;
  spots: number;
  ratePerDay: Money;

  lines: QuoteLine[];

  /** Sum of taxable values across every line, after the rate discount. */
  netValue: Money;
  gstAmount: Money;
  /** What the advertiser owes before any goodwill is applied. */
  grossTotal: Money;
  /** Goodwill applied to the gross, as a payment rather than a price cut. */
  goodwillApplied: Money;
  /** What actually has to be paid. */
  payable: Money;

  /** Cart-facing: the media line only, plus whether more is coming. */
  cartTotal: Money;
  hasUndisclosedFees: boolean;
  /** Named in the cart even where the amount is not — see docs. */
  disclosedFeeNames: string[];

  publisher: {
    grossEarnings: Money;
    commissionPct: Rate;
    commissionSource: CommissionSource;
    commissionAmount: Money;
    netEarnings: Money;
  };
};

export type QuoteInput = {
  listingId: string;
  days: number;
  spots?: number;
  /** Reduces taxable value before GST. Not the same thing as goodwill. */
  rateDiscount?: Money;
  /** Applied to the gross after GST, because it is a payment. */
  goodwill?: Money;
  /** Overrides the listing's current rate when a price lock holds an older one. */
  ratePerDay?: Money;
  at?: Date;
};

/**
 * Prices one booking, both sides of it.
 *
 * Tax is per line rather than one rate over a total: printing and media need
 * not carry the same GST, and averaging them would be wrong in a way no total
 * reveals.
 */
export async function quote(input: QuoteInput): Promise<Quote> {
  const at = input.at ?? new Date();
  const days = Math.floor(input.days);
  const spots = Math.max(1, Math.floor(input.spots ?? 1));
  if (days < 1) throw new ApiError(400, 'BAD_REQUEST', 'A booking needs at least one day');

  const listing = await repository.listingForQuote(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');

  const ratePerDay = input.ratePerDay ?? listing.ratePerDay;
  if (ratePerDay === null) {
    throw new ApiError(409, 'CONFLICT', 'This listing has no rate, so it cannot be quoted');
  }

  const mediaValue = new D(ratePerDay).times(days).times(spots);
  const discount = new D(input.rateDiscount ?? 0);
  if (discount.greaterThan(mediaValue)) {
    throw new ApiError(400, 'BAD_REQUEST', 'A discount cannot exceed the media value');
  }
  const mediaTaxable = mediaValue.minus(discount);

  // The rental slab is keyed on what the advertiser is billed per unit per
  // day — after the rate discount, before the campaign discount and the fees
  // — so a quantity of three does not push one ₹1,000 spot into the ₹3,000
  // band, and a discounted spot is banded at the price it actually fetched.
  const inputs = await repository.pricingInputs({
    publisherId: listing.publisherId,
    category: listing.category,
    mediaTypeId: listing.mediaTypeId,
    perDayMediaValue: money(mediaTaxable.dividedBy(days).dividedBy(spots)),
    at,
  });
  const mediaGst = new D(inputs.tax?.mediaGstPct ?? FALLBACK_GST_PCT);

  const lines: QuoteLine[] = [
    {
      kind: 'MEDIA',
      label: listing.title,
      taxableValue: money(mediaTaxable),
      gstPct: mediaGst.toString(),
      gstAmount: money(mediaTaxable.times(mediaGst)),
      total: money(mediaTaxable.times(new D(1).plus(mediaGst))),
      amountShownInCart: true,
    },
  ];

  for (const fee of inputs.fees) {
    // A percentage fee is charged on the *discounted* media value: the discount
    // is a reduction in what the advertiser is buying, not a rebate afterwards,
    // so a fee computed on the undiscounted figure would quietly claw part of
    // it back.
    const base =
      fee.percentPct !== null
        ? mediaTaxable.times(new D(fee.percentPct))
        : new D(fee.flatAmount ?? 0).times(fee.perSpot ? spots : 1);
    if (base.lessThanOrEqualTo(0)) continue;

    const gstPct = new D(fee.gstPct);
    lines.push({
      kind: fee.kind,
      label: fee.name,
      taxableValue: money(base),
      gstPct: gstPct.toString(),
      gstAmount: money(base.times(gstPct)),
      total: money(base.times(new D(1).plus(gstPct))),
      amountShownInCart: fee.amountShownInCart,
    });
  }

  const netValue = lines.reduce((sum, line) => sum.plus(new D(line.taxableValue)), new D(0));
  const gstAmount = lines.reduce((sum, line) => sum.plus(new D(line.gstAmount)), new D(0));
  const grossTotal = netValue.plus(gstAmount);

  // Goodwill is a payment, so it applies to the gross and can never exceed it.
  // Treating it as a discount would reduce the taxable value and under-report
  // GST on money that was genuinely charged.
  const goodwill = D.min(new D(input.goodwill ?? 0), grossTotal);

  const commission = resolveCommission(inputs);
  const commissionAmount = mediaTaxable.times(new D(commission.ratePct));

  const cartLines = lines.filter((line) => line.amountShownInCart);
  const cartTotal = cartLines.reduce((sum, line) => sum.plus(new D(line.total)), new D(0));
  const undisclosed = lines.filter((line) => !line.amountShownInCart);

  return {
    listingId: listing.id,
    days,
    spots,
    ratePerDay: money(ratePerDay),
    lines,
    netValue: money(netValue),
    gstAmount: money(gstAmount),
    grossTotal: money(grossTotal),
    goodwillApplied: money(goodwill),
    payable: money(grossTotal.minus(goodwill)),
    cartTotal: money(cartTotal),
    hasUndisclosedFees: undisclosed.length > 0,
    // Named even where the amount is withheld. A cart that implies the media
    // rate is the price and reveals mandatory charges only at the last step is
    // the drip-pricing pattern the CCPA guidelines name; naming them costs the
    // clean cart nothing.
    disclosedFeeNames: undisclosed.map((line) => line.label),
    publisher: {
      grossEarnings: money(mediaTaxable),
      commissionPct: commission.ratePct,
      commissionSource: commission.source,
      commissionAmount: money(commissionAmount),
      netEarnings: money(mediaTaxable.minus(commissionAmount)),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lot B (Q13): what an invoice prints beside each line                */
/* ------------------------------------------------------------------ */

/**
 * Lot J2: the tax row alone — the GST fraction both subscription pricing
 * paths (`publisher-plans` here, `packages` on the advertiser side) read,
 * so the configurable GST is `PATCH /revenue/tax` and nothing else. Not a
 * second setting; the same row `quote()` and the invoice read.
 */
export async function taxSettings(): Promise<{ mediaGstPct: Rate }> {
  const tax = await repository.getTaxSettings();
  return { mediaGstPct: new D(tax?.mediaGstPct ?? FALLBACK_GST_PCT).toString() };
}

export type InvoiceTaxCodes = {
  /** A fraction — 0.18. */
  mediaGstPct: Rate;
  mediaSacCode: string | null;
  fees: { kind: FeeKind; name: string; sacCode: string | null; gstPct: Rate; perSpot: boolean; percentPct: Rate | null }[];
};

/**
 * The SAC and GST rate for the media line and for each active fee, read by
 * `invoices` when a booking is invoiced. The amounts come from `quote()` —
 * the same call the checkout made — so an invoice cannot disagree with the
 * total that was held; this only adds the codes printed beside them.
 */
export async function invoiceTaxCodes(): Promise<InvoiceTaxCodes> {
  const [tax, fees] = await Promise.all([repository.getTaxSettings(), repository.listFees(false)]);
  return {
    mediaGstPct: new D(tax?.mediaGstPct ?? FALLBACK_GST_PCT).toString(),
    mediaSacCode: tax?.mediaSacCode ?? null,
    fees: fees.map((fee) => ({
      kind: fee.kind,
      name: fee.name,
      sacCode: fee.sacCode ?? null,
      gstPct: new D(fee.gstPct).toString(),
      perSpot: fee.perSpot,
      percentPct: fee.percentPct === null ? null : new D(fee.percentPct).toString(),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Price locks                                                         */
/* ------------------------------------------------------------------ */

/** Thirty minutes for an ordinary cart. */
export const LOCK_MINUTES = 30;
/** A working day for a bulk cart, which takes longer to assemble. */
export const BULK_LOCK_MINUTES = 60 * 24;
/** Above this many spots, a cart counts as bulk. */
export const BULK_SPOT_THRESHOLD = 5;

export function lockDuration(spotsInCart: number): number {
  return spotsInCart > BULK_SPOT_THRESHOLD ? BULK_LOCK_MINUTES : LOCK_MINUTES;
}

/**
 * Holds a rate while somebody decides.
 *
 * The price only — never the inventory. A lock that reserved the site would let
 * anyone empty the marketplace by filling a cart and walking away, and no
 * amount of expiry tuning fixes that.
 */
export async function lockPrice(input: {
  advertiserId: string;
  listingId: string;
  spotsInCart: number;
  at?: Date;
}): Promise<{ ratePerDay: Money; expiresAt: Date }> {
  const at = input.at ?? new Date();
  const listing = await repository.listingForQuote(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.ratePerDay === null) {
    throw new ApiError(409, 'CONFLICT', 'This listing has no rate to lock');
  }

  const expiresAt = new Date(at.getTime() + lockDuration(input.spotsInCart) * 60_000);
  const lock = await repository.upsertPriceLock({
    advertiserId: input.advertiserId,
    listingId: input.listingId,
    ratePerDay: listing.ratePerDay,
    expiresAt,
  });
  return { ratePerDay: money(lock.ratePerDay), expiresAt: lock.expiresAt };
}

/**
 * The locked rate, if the lock is still good.
 *
 * Expiry is by timestamp rather than by a sweeper: an expired lock simply stops
 * resolving, so there is no window in which a stale lock is still honoured
 * because a job has not run yet.
 */
export async function heldRate(
  advertiserId: string,
  listingId: string,
  at: Date = new Date()
): Promise<Money | null> {
  const lock = await repository.findPriceLock(advertiserId, listingId);
  if (!lock) return null;
  if (lock.consumedAt !== null) return null;
  if (lock.expiresAt <= at) return null;
  return money(lock.ratePerDay);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const asFraction = (value: string, label: string): string => {
  const rate = new D(value);
  if (rate.lessThan(0) || rate.greaterThan(1)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `${label} is a fraction between 0 and 1 — 0.15 is fifteen percent, not 15`
    );
  }
  return rate.toString();
};

/**
 * Writes one commission-rate row: the platform default (no key), a category
 * rate, a media-type rate, or a media-type rate for one rental band.
 *
 * A band without a media type is refused — a rental band is a claim about a
 * kind of spot, and a band on the platform default would silently re-rate
 * every listing that has no media type. A row keyed on both a category and a
 * media type is refused too: the ladder tries them one after the other, and
 * a row that answers to both would win under one name and be invisible under
 * the other.
 */
export async function setCommissionRate(input: {
  category: ListingCategory | null;
  mediaTypeId?: string | null;
  minMediaValue?: string | null;
  maxMediaValue?: string | null;
  ratePct: string;
  note: string | null;
  userId: string;
}) {
  const mediaTypeId = input.mediaTypeId ?? null;
  const min = input.minMediaValue == null ? null : new D(input.minMediaValue);
  const max = input.maxMediaValue == null ? null : new D(input.maxMediaValue);

  if (input.category && mediaTypeId) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'A commission rate is keyed on a category or a media type, never both'
    );
  }
  if ((min || max) && !mediaTypeId) {
    throw new ApiError(400, 'BAD_REQUEST', 'A rental band needs a media type');
  }
  if ((min && min.lessThan(0)) || (max && max.lessThan(0))) {
    throw new ApiError(400, 'BAD_REQUEST', 'A rental band cannot be negative');
  }
  if (min && max && !min.lessThan(max)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'A rental band runs from its floor up to, but not including, its ceiling — the floor must be lower'
    );
  }

  const row: NewCommissionRate = {
    category: input.category,
    mediaTypeId,
    minMediaValue: min ? money(min) : null,
    maxMediaValue: max ? money(max) : null,
    ratePct: asFraction(input.ratePct, 'A commission rate'),
    note: input.note,
    userId: input.userId,
  };
  return repository.upsertCommissionRate(row);
}

export async function grantSubscription(input: {
  publisherId: string;
  tier: 'STANDARD' | 'PLUS' | 'PRO';
  ratePct: string;
  pricePerMonth: string;
  startsAt: Date;
  endsAt: Date | null;
}) {
  return repository.createSubscription({
    ...input,
    ratePct: asFraction(input.ratePct, 'A subscription commission rate'),
    pricePerMonth: money(input.pricePerMonth),
  });
}

/**
 * Lot I: the tier a publisher is running on right now — `{ tier, startsAt,
 * endsAt }` or null. Read by `support`'s live-chat entitlement: a running
 * subscription is what makes a publisher a paid subscriber. The same rule
 * the commission resolution applies (started, not ended, the best rate when
 * two overlap), asked without the rest of the pricing inputs.
 */
export async function runningSubscriptionForPublisher(
  publisherId: string,
  at: Date = new Date(),
): Promise<{ id: string; tier: 'STANDARD' | 'PLUS' | 'PRO'; startsAt: Date; endsAt: Date | null } | null> {
  const row = await repository.findRunningSubscription(publisherId, at);
  return row ? { id: row.id, tier: row.tier, startsAt: row.startsAt, endsAt: row.endsAt } : null;
}

/**
 * The same fact for a set of publishers in one query — Lot I (I4-B), what
 * `support`'s inbox asks so a page of chats costs one read, not one per
 * row. A publisher with nothing running is absent from the map; when two
 * rows overlap the best rate wins, as it does for one.
 */
export async function runningSubscriptionsForPublishers(
  publisherIds: readonly string[],
  at: Date = new Date(),
): Promise<Map<string, { id: string; tier: 'STANDARD' | 'PLUS' | 'PRO'; startsAt: Date; endsAt: Date | null }>> {
  const out = new Map<string, { id: string; tier: 'STANDARD' | 'PLUS' | 'PRO'; startsAt: Date; endsAt: Date | null }>();
  const unique = [...new Set(publisherIds)];
  if (unique.length === 0) return out;
  for (const row of await repository.findRunningSubscriptions(unique, at)) {
    if (!out.has(row.publisherId)) out.set(row.publisherId, { id: row.id, tier: row.tier, startsAt: row.startsAt, endsAt: row.endsAt });
  }
  return out;
}

/**
 * A promotional rate on ADX's own take.
 *
 * The approver is recorded and the reason is required. This is ADX giving up
 * revenue to win a publisher, and an unexplained one is the first thing finance
 * will ask about.
 */
export async function grantCommissionOverride(input: {
  publisherId: string;
  ratePct: string;
  reason: string;
  approvedById: string;
  startsAt: Date;
  endsAt: Date | null;
}) {
  if (input.reason.trim().length < 4) {
    throw new ApiError(400, 'BAD_REQUEST', 'Say why this publisher is getting a promotional rate');
  }
  return repository.createOverride({
    ...input,
    reason: input.reason.trim(),
    ratePct: asFraction(input.ratePct, 'A commission rate'),
  });
}
