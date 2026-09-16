import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';

/**
 * Converting the publisher's own pricing unit into the platform's.
 *
 * DR 02 step 7 lets a publisher state a price the way their medium is normally
 * quoted — a mall talks in rupees per square foot per month, a billboard owner
 * in rupees per day. Forcing either into the other at data entry is how a rate
 * gets mistyped by a factor of thirty, so the form takes their unit and this
 * derives `ratePerDay`, which is what everything downstream compares.
 *
 * Both are stored. The publisher's figure is what they will recognise on their
 * own listing; the daily rate is what the engine, the cart and the invoice use.
 * Keeping only the derived one would mean showing a mall owner a number they
 * never typed.
 */

export type PricingUnit =
  | 'PER_DAY'
  | 'PER_WEEK'
  | 'PER_MONTH'
  | 'PER_SQFT_PER_DAY'
  | 'PER_SQFT_PER_MONTH';

/**
 * A flat 30, matching the derivation used elsewhere for `monthlyPrice`.
 *
 * The real month length would make the same listing worth 3% more or less
 * depending on which month it was entered in, which is a worse problem than
 * being approximate in a way everyone can predict.
 */
export const DAYS_PER_MONTH = 30;
export const DAYS_PER_WEEK = 7;

export function ratePerDayFrom(input: {
  unit: PricingUnit;
  basePrice: string;
  /** Required for the per-square-foot units, meaningless for the others. */
  areaSqFt?: string | null;
}): Money {
  const base = new Decimal(input.basePrice);
  if (base.lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'A price must be greater than zero');
  }

  const needsArea =
    input.unit === 'PER_SQFT_PER_DAY' || input.unit === 'PER_SQFT_PER_MONTH';
  if (needsArea && !input.areaSqFt) {
    // The column has a CHECK for the same reason. Caught here so it arrives as
    // a sentence rather than a constraint violation rendered as a 500 — and
    // because without an area the conversion silently produces zero.
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'A per-square-foot price needs the spot dimensions, so the area can be worked out'
    );
  }

  const area = needsArea ? new Decimal(input.areaSqFt!) : new Decimal(1);
  if (needsArea && area.lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'A spot with no area cannot be priced per square foot');
  }

  const perDay = (() => {
    switch (input.unit) {
      case 'PER_DAY':
        return base;
      case 'PER_WEEK':
        return base.dividedBy(DAYS_PER_WEEK);
      case 'PER_MONTH':
        return base.dividedBy(DAYS_PER_MONTH);
      case 'PER_SQFT_PER_DAY':
        return base.times(area);
      case 'PER_SQFT_PER_MONTH':
        return base.times(area).dividedBy(DAYS_PER_MONTH);
    }
  })();

  const rounded = money(perDay);
  // Checked after rounding, which is the value that reaches the column. A
  // per-month price under 30 paise rounds to zero a day.
  if (new Decimal(rounded).lessThanOrEqualTo(0)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'That works out to nothing per day — check the price and the unit'
    );
  }
  // And at the other end. A per-square-foot rate multiplied by a large area can
  // exceed `Decimal(14,2)` from two individually reasonable numbers, and the
  // column would refuse it as a numeric overflow rendered as a 500. Every other
  // bad price in this file is a sentence; so is this one.
  if (new Decimal(rounded).greaterThan(MAX_RATE)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'That works out to more per day than a listing can hold — check the price and the unit'
    );
  }
  return rounded;
}

/** `Decimal(14,2)` on `Listing.ratePerDay` and `basePrice`. */
const MAX_RATE = new Decimal('999999999999.99');

/** `Decimal(10,2)` on `Listing.areaSqFt`. */
const MAX_AREA = new Decimal('99999999.99');

/** Area from measured dimensions, so nothing stores an area that disagrees. */
export function areaFrom(widthFt: string, heightFt: string): Money {
  const width = new Decimal(widthFt);
  const height = new Decimal(heightFt);
  if (width.lessThanOrEqualTo(0) || height.lessThanOrEqualTo(0)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Width and height must both be greater than zero');
  }
  const area = money(width.times(height));
  if (new Decimal(area).greaterThan(MAX_AREA)) {
    throw new ApiError(400, 'BAD_REQUEST', 'That is larger than any spot a listing can hold');
  }
  return area;
}

/** How the publisher's own figure reads back to them. */
export const UNIT_LABEL: Record<PricingUnit, string> = {
  PER_DAY: 'per day',
  PER_WEEK: 'per week',
  PER_MONTH: 'per month',
  PER_SQFT_PER_DAY: 'per sq ft per day',
  PER_SQFT_PER_MONTH: 'per sq ft per month',
};
