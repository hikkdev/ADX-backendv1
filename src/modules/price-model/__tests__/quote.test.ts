import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The arithmetic behind a number an advertiser is told on the phone.
 *
 * A quote is an offer made in ADX's name, and the operator making it is
 * negotiating live. What matters is that the total is right, that the discount
 * is applied where they think it is, and that a price which has slipped under
 * the floor says so before it is sent rather than after it is accepted.
 */

const { repository, effectiveCardEntry } = vi.hoisted(() => ({
  repository: {
    listDimensions: vi.fn(),
    findCategoryRule: vi.fn(),
    rulesInForce: vi.fn(),
    createQuote: vi.fn(),
    referenceExists: vi.fn(),
    findQuote: vi.fn(),
    setQuoteStatus: vi.fn(),
    listQuotes: vi.fn(),
  },
  effectiveCardEntry: vi.fn(),
}));

vi.mock('../prisma-price-model.repository', () => ({ prismaPriceModelRepository: repository }));
vi.mock('../../rate-cards', () => ({ effectiveCardEntry }));

import { priceQuote } from '../quote.service';

/** 10,000 a day, 82% floor — so 8,200 — rounding to the nearest 100. */
const card = () => ({
  card: {
    id: 'rc_1',
    name: 'Bengaluru Metro Premium',
    version: 4,
    floorPct: new Decimal('0.82'),
    roundingRupees: 100,
  },
  entry: { ratePerDay: new Decimal('10000.00') },
});

const line = (over: Record<string, unknown> = {}) => ({
  mediaTypeId: 'mt_1',
  grade: 'A' as const,
  label: 'MG Road Billboard',
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  createdById: 'usr_1',
  lines: [line()],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  effectiveCardEntry.mockResolvedValue(card());
  repository.listDimensions.mockResolvedValue([]);
  repository.findCategoryRule.mockResolvedValue(null);
  repository.rulesInForce.mockResolvedValue([]);
});

describe('one line', () => {
  it('prices from the card and says which card', async () => {
    const quote = await priceQuote(input());
    expect(quote.lines[0]!.ratePerDay).toBe('10000.00');
    expect(quote.lines[0]!.steps[0]).toMatchObject({
      step: 'Card rate',
      rule: 'Bengaluru Metro Premium v4 · grade A',
    });
  });

  /** Quantity multiplies the daily rate; days multiply the total. Confusing the
   *  two is how a fortnight of six hoardings gets quoted as one hoarding. */
  it('multiplies by quantity and by days', async () => {
    const quote = await priceQuote(input({ lines: [line({ quantity: 6, days: 14 })] }));
    expect(quote.lines[0]!.lineTotal).toBe('840000.00');
    expect(quote.subtotalPerDay).toBe('60000.00');
    expect(quote.grandTotal).toBe('840000.00');
  });
});

describe('several lines', () => {
  it('sums the daily rates and the flight totals separately', async () => {
    const quote = await priceQuote(
      input({
        lines: [
          line({ label: 'A', days: 30 }),
          line({ label: 'B', quantity: 2, days: 7 }),
        ],
      })
    );
    // 10,000 + 20,000 a day.
    expect(quote.subtotalPerDay).toBe('30000.00');
    // 300,000 over thirty days, plus 140,000 over seven.
    expect(quote.grandTotal).toBe('440000.00');
  });
});

describe('the discount', () => {
  it('comes off the total, not off each card rate', async () => {
    const quote = await priceQuote(input({ discountPct: '10', lines: [line({ days: 10 })] }));
    // The line still quotes at the card rate; the discount is the concession.
    expect(quote.lines[0]!.ratePerDay).toBe('10000.00');
    expect(quote.subtotalPerDay).toBe('10000.00');
    expect(quote.totalPerDay).toBe('9000.00');
    expect(quote.grandTotal).toBe('90000.00');
  });

  /**
   * The floor is per line per day, so it has to be re-tested *after* the
   * discount. A quote that passes line by line and breaches once ten per cent
   * comes off is exactly what the approvals queue exists for, and the operator
   * has to see it before the offer leaves the room.
   */
  it('reports a breach the discount caused, not just one the card caused', async () => {
    const ok = await priceQuote(input({ discountPct: '10' }));
    expect(ok.lines[0]!.belowFloor).toBe(false);
    expect(ok.belowFloor).toBe(false);

    // 10,000 less 20% is 8,000, under the 8,200 floor.
    const breached = await priceQuote(input({ discountPct: '20' }));
    expect(breached.lines[0]!.belowFloor).toBe(false);
    expect(breached.belowFloor).toBe(true);
  });

  it('refuses a discount that is not a discount', async () => {
    await expect(priceQuote(input({ discountPct: '100' }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('the sector', () => {
  it('applies a sector multiplier and names it in the trace', async () => {
    repository.findCategoryRule.mockResolvedValue({
      sector: 'Alcohol',
      mediaTypeName: 'Hoarding',
      effect: 'MULTIPLIER',
      multiplier: new Decimal('1.25'),
    });
    const quote = await priceQuote(input({ sector: 'Alcohol' }));
    expect(quote.lines[0]!.ratePerDay).toBe('12500.00');
    expect(quote.lines[0]!.steps.some((step) => step.step === 'Sector')).toBe(true);
  });

  /**
   * A blocked sector stops the quote rather than pricing it. Returning a number
   * for inventory this advertiser may not book is how a salesperson quotes
   * something the platform refuses at checkout.
   */
  it('refuses to price inventory the sector may not book', async () => {
    repository.findCategoryRule.mockResolvedValue({ sector: 'Tobacco', effect: 'BLOCKED' });
    await expect(priceQuote(input({ sector: 'Tobacco' }))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('prices a sector that only needs sign-off, and flags it', async () => {
    repository.findCategoryRule.mockResolvedValue({
      sector: 'Gambling',
      effect: 'LEGAL_APPROVAL',
      multiplier: null,
    });
    const quote = await priceQuote(input({ sector: 'Gambling' }));
    expect(quote.needsLegalApproval).toEqual(['MG Road Billboard']);
    expect(quote.lines[0]!.ratePerDay).toBe('10000.00');
  });
});

describe('rules', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    name: 'Long flight',
    priority: 100,
    adjustment: 'MULTIPLIER',
    value: new Decimal('0.9'),
    conditions: [],
    ...over,
  });

  it('fires a rule whose conditions all hold', async () => {
    repository.rulesInForce.mockResolvedValue([
      rule({ conditions: [{ field: 'days', operator: 'gte', value: '14' }] }),
    ]);
    const quote = await priceQuote(input({ lines: [line({ days: 30 })] }));
    expect(quote.lines[0]!.ratePerDay).toBe('9000.00');
  });

  it('leaves a rule alone when a condition fails', async () => {
    repository.rulesInForce.mockResolvedValue([
      rule({ conditions: [{ field: 'days', operator: 'gte', value: '14' }] }),
    ]);
    const quote = await priceQuote(input({ lines: [line({ days: 7 })] }));
    expect(quote.lines[0]!.ratePerDay).toBe('10000.00');
  });

  /**
   * A rule testing a fact the line does not carry has not matched. Treating a
   * missing area as zero would fire every "under 200 sq ft" rule on every
   * unmeasured spot.
   */
  it('does not fire on a fact the line does not have', async () => {
    repository.rulesInForce.mockResolvedValue([
      rule({ conditions: [{ field: 'areaSqFt', operator: 'lt', value: '200' }] }),
    ]);
    const quote = await priceQuote(input());
    expect(quote.lines[0]!.ratePerDay).toBe('10000.00');
  });

  it('adds rupees before it multiplies', async () => {
    repository.rulesInForce.mockResolvedValue([
      rule({ id: 'r2', name: 'Corner site', adjustment: 'BASE_ADJUST', value: new Decimal('500') }),
      rule({ id: 'r1', name: 'Long flight', adjustment: 'MULTIPLIER', value: new Decimal('1.15') }),
    ]);
    const quote = await priceQuote(input());
    // (10,000 + 500) x 1.15 = 12,075, rounded to the card's nearest hundred.
    expect(quote.lines[0]!.ratePerDay).toBe('12100.00');
  });
});

describe('size bands', () => {
  it('picks the band the measured area falls in', async () => {
    repository.listDimensions.mockResolvedValue([
      {
        id: 'd1',
        name: 'Size band',
        values: [
          {
            id: 'v1',
            label: 'Super',
            multiplier: new Decimal('1.3'),
            minAreaSqFt: new Decimal('450'),
            maxAreaSqFt: new Decimal('800'),
            isActive: true,
          },
        ],
      },
    ]);
    const quote = await priceQuote(input({ lines: [line({ areaSqFt: '600' })] }));
    expect(quote.lines[0]!.ratePerDay).toBe('13000.00');
    expect(quote.lines[0]!.steps.some((step) => step.rule.includes('Super'))).toBe(true);
  });

  it('leaves an area outside every band alone', async () => {
    repository.listDimensions.mockResolvedValue([
      {
        id: 'd1',
        name: 'Size band',
        values: [
          {
            id: 'v1',
            label: 'Super',
            multiplier: new Decimal('1.3'),
            minAreaSqFt: new Decimal('450'),
            maxAreaSqFt: new Decimal('800'),
            isActive: true,
          },
        ],
      },
    ]);
    const quote = await priceQuote(input({ lines: [line({ areaSqFt: '80' })] }));
    expect(quote.lines[0]!.ratePerDay).toBe('10000.00');
  });
});

describe('what it will not quote', () => {
  it('refuses where no approved card reaches, rather than inventing a base', async () => {
    effectiveCardEntry.mockResolvedValue(null);
    await expect(priceQuote(input())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses an empty quote', async () => {
    await expect(priceQuote(input({ lines: [] }))).rejects.toMatchObject({ statusCode: 400 });
  });
});
