import type {
  CommissionRate,
  FeeKind,
  FeeSchedule,
  ListingCategory,
  PriceLock,
  PublisherCommissionOverride,
  PublisherSubscription,
  SubscriptionTierName,
  TaxSettings,
} from '../../shared/database';

/** Decimal string on the wire, never a float. See docs/revenue-model.md. */
export type Money = string;

/** A fraction, not a percentage: 0.0050 is half a percent. */
export type Rate = string;

/**
 * Everything needed to price one booking, fetched together.
 *
 * One read rather than four, because a quote assembled from rates fetched at
 * different moments can straddle an ops edit and produce a total whose parts do
 * not agree with each other.
 */
export type PricingInputs = {
  defaultCommission: CommissionRate | null;
  categoryCommission: CommissionRate | null;
  /**
   * Lot B (Q10/Q38): the active row keyed on the listing's media type with no
   * rental band, and the one whose band `[minMediaValue, maxMediaValue)`
   * contains the per-day media value being priced. Either is null when no
   * such row exists, or the listing has no media type.
   */
  mediaTypeCommission: CommissionRate | null;
  mediaTypeSlabCommission: CommissionRate | null;
  subscription: PublisherSubscription | null;
  override: PublisherCommissionOverride | null;
  fees: FeeSchedule[];
  tax: TaxSettings | null;
};

export type NewSubscription = {
  publisherId: string;
  tier: SubscriptionTierName;
  ratePct: Rate;
  pricePerMonth: Money;
  startsAt: Date;
  endsAt: Date | null;
};

export type NewOverride = {
  publisherId: string;
  ratePct: Rate;
  reason: string;
  approvedById: string;
  startsAt: Date;
  endsAt: Date | null;
};

export type NewFee = {
  kind: FeeKind;
  name: string;
  percentPct: Rate | null;
  flatAmount: Money | null;
  gstPct: Rate;
  amountShownInCart: boolean;
  perSpot: boolean;
};

/**
 * One commission-rate row as ops writes it. Exactly one of `category` and
 * `mediaTypeId` may be set; both null is the platform default. A rental band
 * needs a media type.
 */
export type NewCommissionRate = {
  category: ListingCategory | null;
  mediaTypeId: string | null;
  minMediaValue: Money | null;
  maxMediaValue: Money | null;
  ratePct: Rate;
  note: string | null;
  userId: string;
};

export interface RevenueRepository {
  /** Everything a quote needs, in one round trip. */
  pricingInputs(input: {
    publisherId: string | null;
    category: ListingCategory;
    mediaTypeId: string | null;
    /** Per unit per day, after the rate discount — what the slab is keyed on. */
    perDayMediaValue: Money;
    at: Date;
  }): Promise<PricingInputs>;

  /* Commission rates. */
  listCommissionRates(): Promise<CommissionRate[]>;
  upsertCommissionRate(data: NewCommissionRate): Promise<CommissionRate>;

  /* Subscriptions. */
  listSubscriptions(publisherId?: string): Promise<PublisherSubscription[]>;
  createSubscription(data: NewSubscription): Promise<PublisherSubscription>;
  endSubscription(id: string, endsAt: Date): Promise<PublisherSubscription>;
  findSubscription(id: string): Promise<PublisherSubscription | null>;
  /** Lot I: the subscription in force for a publisher at `at` — started, not ended; the best rate when two overlap. */
  findRunningSubscription(publisherId: string, at: Date): Promise<PublisherSubscription | null>;
  /** Lot I (I4-B): the same read for a set of publishers in one query — every running row, best rate first, so the caller keeps the first per publisher. */
  findRunningSubscriptions(publisherIds: readonly string[], at: Date): Promise<PublisherSubscription[]>;
  /** Lot J2 (grace): the publisher's most recently ended subscription with `endsAt` in `(since, at]`, or null. */
  findLapsedSubscription(publisherId: string, since: Date, at: Date): Promise<PublisherSubscription | null>;
  /** Lot J2 (grace): the same for a set — every row ended in the window, latest end first, so the caller keeps the first per publisher. */
  findLapsedSubscriptions(publisherIds: readonly string[], since: Date, at: Date): Promise<PublisherSubscription[]>;

  /* Promotional overrides. */
  listOverrides(publisherId?: string): Promise<PublisherCommissionOverride[]>;
  createOverride(data: NewOverride): Promise<PublisherCommissionOverride>;

  /* Fees. */
  listFees(includeInactive?: boolean): Promise<FeeSchedule[]>;
  findFee(id: string): Promise<FeeSchedule | null>;
  createFee(data: NewFee): Promise<FeeSchedule>;
  updateFee(id: string, patch: Record<string, unknown>, userId: string): Promise<FeeSchedule>;

  /* Tax. */
  getTaxSettings(): Promise<TaxSettings | null>;
  updateTaxSettings(mediaGstPct: Rate, userId: string): Promise<TaxSettings>;

  /* Price locks. */
  upsertPriceLock(data: {
    advertiserId: string;
    listingId: string;
    ratePerDay: Money;
    expiresAt: Date;
  }): Promise<PriceLock>;
  findPriceLock(advertiserId: string, listingId: string): Promise<PriceLock | null>;
  consumePriceLock(id: string): Promise<void>;

  /** The listing being priced: its rate, its category, its media type, and whose it is. */
  listingForQuote(listingId: string): Promise<{
    id: string;
    publisherId: string | null;
    category: ListingCategory;
    mediaTypeId: string | null;
    ratePerDay: Money | null;
    title: string;
  } | null>;
}
