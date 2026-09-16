import { describe, expect, it } from 'vitest';
import { areaFrom, ratePerDayFrom } from '../listing-pricing';

/**
 * DR 02 step 7 lets a publisher price in their own unit. This is the conversion
 * to the platform's, and it is arithmetic on money — the kind of code where a
 * wrong answer looks entirely plausible and costs real rupees for months.
 */

describe('rate per day', () => {
    it('passes a daily rate through untouched', () => {
        expect(ratePerDayFrom({ unit: 'PER_DAY', basePrice: '2500' })).toBe('2500.00');
    });

    it('divides a monthly rate by a flat thirty', () => {
        expect(ratePerDayFrom({ unit: 'PER_MONTH', basePrice: '36000' })).toBe('1200.00');
    });

    it('divides a weekly rate by seven', () => {
        expect(ratePerDayFrom({ unit: 'PER_WEEK', basePrice: '7000' })).toBe('1000.00');
    });

    /**
     * The case DR 02 actually draws: a gym mirror decal at 6ft x 4ft, priced at
     * Rs 150 per square foot per month. 24 sq ft x 150 = 3,600 a month = 120 a day.
     */
    it('multiplies by area then divides, for a per-square-foot monthly rate', () => {
        expect(
            ratePerDayFrom({ unit: 'PER_SQFT_PER_MONTH', basePrice: '150', areaSqFt: '24' })
        ).toBe('120.00');
    });

    it('multiplies by area for a per-square-foot daily rate', () => {
        expect(
            ratePerDayFrom({ unit: 'PER_SQFT_PER_DAY', basePrice: '5', areaSqFt: '24' })
        ).toBe('120.00');
    });

    /**
     * Without an area the multiplication silently produces zero, which would be
     * a free listing rather than an error anybody notices.
     */
    it('refuses a per-square-foot price with no area', () => {
        expect(() => ratePerDayFrom({ unit: 'PER_SQFT_PER_MONTH', basePrice: '150' })).toThrow();
        expect(() =>
            ratePerDayFrom({ unit: 'PER_SQFT_PER_MONTH', basePrice: '150', areaSqFt: '0' })
        ).toThrow();
    });

    it('refuses a price of zero or less whatever the unit', () => {
        expect(() => ratePerDayFrom({ unit: 'PER_DAY', basePrice: '0' })).toThrow();
        expect(() => ratePerDayFrom({ unit: 'PER_MONTH', basePrice: '0' })).toThrow();
    });

    /**
     * Checked after rounding, because rounding is what reaches the column. A
     * monthly price under fifteen paise is a positive number that becomes zero a
     * day, and a zero rate drags a whole comparable pool to the floor.
     */
    it('refuses a price that rounds away to nothing per day', () => {
        // 0.10 a month is 0.0033 a day, which rounds to nothing.
        expect(() => ratePerDayFrom({ unit: 'PER_MONTH', basePrice: '0.10' })).toThrow();
        // 0.15 a month is 0.005 a day, which rounds up to a paisa and survives —
        // so the guard rejects only what actually disappears.
        expect(ratePerDayFrom({ unit: 'PER_MONTH', basePrice: '0.15' })).toBe('0.01');
    });

    it('keeps two decimal places rather than a repeating fraction', () => {
        // 1000/30 is 33.333…; the column holds two places and so does the wire.
        expect(ratePerDayFrom({ unit: 'PER_MONTH', basePrice: '1000' })).toBe('33.33');
    });
});

describe('area', () => {
    it('is the product of the measured dimensions', () => {
        expect(areaFrom('6', '4')).toBe('24.00');
        expect(areaFrom('40', '20')).toBe('800.00');
    });

    it('handles fractional feet, since spots are measured not chosen', () => {
        expect(areaFrom('6.5', '4')).toBe('26.00');
    });

    it('refuses a dimension of zero or less', () => {
        expect(() => areaFrom('0', '4')).toThrow();
        expect(() => areaFrom('6', '0')).toThrow();
    });
});

/**
 * The arithmetic the console mirrors, pinned.
 *
 * `adx-adminUI-sai/src/lib/rate-per-day.ts` reimplements this in integer paise
 * so the figure the form shows under the price field is the figure that gets
 * stored. These are the cases where a float implementation drifted — if the
 * rule here changes, the console has to change with it, and a diff on this
 * block is the only warning anyone will get.
 */
describe('what the console has to agree with', () => {
  it('rounds the area once, before a per-square-foot rate multiplies it', () => {
    // 3.33 x 3.33 = 11.0889, rounded to 11.09 and *then* multiplied. Rounding
    // at the end instead gives 110889.00 — eleven rupees a day adrift.
    const area = areaFrom('3.33', '3.33');
    expect(area).toBe('11.09');
    expect(ratePerDayFrom({ unit: 'PER_SQFT_PER_DAY', basePrice: '10000', areaSqFt: area })).toBe(
      '110900.00'
    );
  });

  it('rounds a division half-up on the exact value, not on a binary double', () => {
    // 100.05 / 30 is exactly 3.335, which rounds up. As a double it is
    // 3.3349999999999995, which rounds down.
    expect(ratePerDayFrom({ unit: 'PER_MONTH', basePrice: '100.05' })).toBe('3.34');
  });

  it('refuses a figure larger than the column can hold rather than letting it 500', () => {
    expect(() =>
      ratePerDayFrom({ unit: 'PER_SQFT_PER_DAY', basePrice: '999999999999', areaSqFt: '1000' })
    ).toThrow(/more per day than a listing can hold/);
  });

  it('refuses an area larger than the column can hold', () => {
    expect(() => areaFrom('9999.99', '9999.99')).not.toThrow();
    expect(() => areaFrom('99999', '99999')).toThrow(/larger than any spot/);
  });
});
