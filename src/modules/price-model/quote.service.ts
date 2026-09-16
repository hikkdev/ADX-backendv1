import { randomBytes } from 'node:crypto';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { effectiveCardEntry } from '../rate-cards';
import { prismaPriceModelRepository as repository } from './prisma-price-model.repository';
import {
  bandForArea,
  categoryRuleFor,
  dimensionValues,
  rulesFor,
  type QuoteFacts,
} from './price-model.service';

/**
 * A quote an operator builds by hand and hands to an advertiser.
 *
 * This is what the manual model exists for. An advertiser taking one spot at
 * the listed price never needs it; an advertiser taking eleven spots across
 * three cities and wanting something off the total does, and that conversation
 * happens on the phone before anything is booked.
 *
 * Every line is priced the same way and each step is recorded, because the
 * quote outlives the inputs. A card gets superseded, a dimension gets retuned,
 * and six weeks later somebody asks how 4,80,000 was arrived at. The stored
 * trace answers that; recomputing would answer a different question.
 */

export type QuoteLineInput = {
  mediaTypeId: string;
  grade: 'PREMIUM' | 'A' | 'B' | 'C';
  cityId?: string | null;
  listingId?: string | null;
  label?: string | null;
  quantity?: number;
  days?: number;
  /** Chosen values, one per dimension. */
  dimensionValueIds?: string[];
  /** Measured area, which picks a size band automatically when one covers it. */
  areaSqFt?: string | null;
};

export type BuildQuoteInput = {
  createdById: string;
  advertiserId?: string | null;
  sector?: string | null;
  notes?: string | null;
  /** What was given away at the table, as a percentage. 10 means ten per cent. */
  discountPct?: string | null;
  expiresAt?: Date | null;
  lines: QuoteLineInput[];
};

export type Step = { step: string; rule: string; factor: string; running: Money };

export type PricedLine = {
  label: string | null;
  mediaTypeId: string;
  grade: string;
  cityId: string | null;
  listingId: string | null;
  quantity: number;
  days: number;
  rateCardId: string | null;
  cardRatePerDay: Money | null;
  floorPerDay: Money | null;
  ratePerDay: Money;
  lineTotal: Money;
  belowFloor: boolean;
  steps: Step[];
};

export type PricedQuote = {
  lines: PricedLine[];
  subtotalPerDay: Money;
  discountPct: string | null;
  totalPerDay: Money;
  grandTotal: Money;
  belowFloor: boolean;
  /** Sectors a category rule refuses outright, and the ones needing sign-off. */
  blocked: string[];
  needsLegalApproval: string[];
};

/**
 * Prices one line, recording every step.
 *
 * The order is deliberate and matches the rate-card simulator: rupee
 * adjustments before multipliers, so a multiplier applies to the whole adjusted
 * figure, and the card's rounding last. Two code paths computing the same quote
 * in different orders is how a simulator and an invoice come to disagree.
 */
async function priceLine(
  line: QuoteLineInput,
  sector: string | null,
  on: Date
): Promise<PricedLine> {
  const found = await effectiveCardEntry(
    line.mediaTypeId,
    line.grade,
    line.cityId ?? null,
    on
  );

  if (!found?.entry.ratePerDay) {
    throw new ApiError(
      409,
      'CONFLICT',
      `No approved rate card prices ${line.label ?? 'this line'} at grade ${line.grade}, so there is no base to quote from.`
    );
  }

  const base = new Decimal(found.entry.ratePerDay);
  const steps: Step[] = [
    {
      step: 'Card rate',
      rule: `${found.card.name} v${found.card.version} · grade ${line.grade}`,
      factor: money(base),
      running: money(base),
    },
  ];

  let running = base;

  // Size band, chosen by the measurement rather than by hand.
  if (line.areaSqFt) {
    const band = await bandForArea(line.areaSqFt);
    if (band) {
      running = running.times(new Decimal(band.value.multiplier));
      steps.push({
        step: band.dimension.name,
        rule: `${band.value.label} · ${line.areaSqFt} sq ft`,
        factor: `${new Decimal(band.value.multiplier).toString()}x`,
        running: money(running),
      });
    }
  }

  // Dimensions the operator picked — illumination, facing, elevation and so on.
  for (const value of await dimensionValues(line.dimensionValueIds ?? [])) {
    running = running.times(value.multiplier);
    steps.push({
      step: value.dimensionName,
      rule: value.label,
      factor: `${value.multiplier.toString()}x`,
      running: money(running),
    });
  }

  // The advertiser's sector.
  if (sector) {
    const rule = await categoryRuleFor(sector, line.mediaTypeId);
    if (rule?.effect === 'MULTIPLIER' && rule.multiplier) {
      running = running.times(new Decimal(rule.multiplier));
      steps.push({
        step: 'Sector',
        rule: `${rule.sector}${rule.mediaTypeName ? ` on ${rule.mediaTypeName}` : ''}`,
        factor: `${new Decimal(rule.multiplier).toString()}x`,
        running: money(running),
      });
    }
  }

  const facts: QuoteFacts = {
    mediaTypeId: line.mediaTypeId,
    grade: line.grade,
    sector,
    areaSqFt: line.areaSqFt ?? null,
    days: line.days ?? 1,
  };

  // Rupee adjustments before multipliers, as everywhere else in the engine.
  const matched = await rulesFor(facts, on);
  for (const rule of matched.filter((r) => r.adjustment === 'BASE_ADJUST')) {
    running = running.plus(new Decimal(rule.value));
    steps.push({
      step: 'Rule',
      rule: rule.name,
      factor: `${new Decimal(rule.value).isNegative() ? '' : '+'}${new Decimal(rule.value).toFixed(2)}`,
      running: money(running),
    });
  }
  for (const rule of matched.filter((r) => r.adjustment === 'MULTIPLIER')) {
    running = running.times(new Decimal(rule.value));
    steps.push({
      step: 'Rule',
      rule: rule.name,
      factor: `${new Decimal(rule.value).toString()}x`,
      running: money(running),
    });
  }
  // An override wins outright, so it goes last and ignores the rest.
  for (const rule of matched.filter((r) => r.adjustment === 'OVERRIDE')) {
    running = new Decimal(rule.value);
    steps.push({ step: 'Override', rule: rule.name, factor: `= ${money(running)}`, running: money(running) });
  }

  const rounding = new Decimal(found.card.roundingRupees);
  if (rounding.greaterThan(0)) {
    const rounded = running
      .dividedBy(rounding)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .times(rounding);
    if (!rounded.equals(running)) {
      running = rounded;
      steps.push({
        step: 'Rounding',
        rule: `Nearest ${found.card.roundingRupees}`,
        factor: '—',
        running: money(running),
      });
    }
  }

  const floor = base.times(new Decimal(found.card.floorPct));
  const quantity = Math.max(1, line.quantity ?? 1);
  const days = Math.max(1, line.days ?? 1);

  return {
    label: line.label ?? null,
    mediaTypeId: line.mediaTypeId,
    grade: line.grade,
    cityId: line.cityId ?? null,
    listingId: line.listingId ?? null,
    quantity,
    days,
    rateCardId: found.card.id,
    cardRatePerDay: money(base),
    floorPerDay: money(floor),
    ratePerDay: money(running),
    lineTotal: money(running.times(quantity).times(days)),
    belowFloor: running.lessThan(floor),
    steps,
  };
}

/**
 * Prices a whole quote without saving it.
 *
 * Separated from saving because negotiation is iterative: an operator moves the
 * discount, sees where it lands against the floors, and moves it back. Writing a
 * row for each of those would fill the table with abandoned arithmetic.
 */
export async function priceQuote(input: BuildQuoteInput, on = new Date()): Promise<PricedQuote> {
  if (input.lines.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A quote needs at least one line.');
  }

  const sector = input.sector?.trim() || null;
  const blocked: string[] = [];
  const needsLegalApproval: string[] = [];

  if (sector) {
    for (const line of input.lines) {
      const rule = await categoryRuleFor(sector, line.mediaTypeId);
      if (rule?.effect === 'BLOCKED') blocked.push(line.label ?? line.mediaTypeId);
      if (rule?.effect === 'LEGAL_APPROVAL') needsLegalApproval.push(line.label ?? line.mediaTypeId);
    }
  }

  /*
   * A blocked sector stops the quote rather than pricing it. Returning a number
   * for inventory this advertiser may not book is how a salesperson ends up
   * quoting something the platform will refuse at checkout.
   */
  if (blocked.length > 0) {
    throw new ApiError(
      409,
      'CONFLICT',
      `This sector may not book ${blocked.join(', ')}. Remove those lines, or change the rule.`
    );
  }

  const lines: PricedLine[] = [];
  for (const line of input.lines) lines.push(await priceLine(line, sector, on));

  const subtotalPerDay = lines.reduce(
    (total, line) => total.plus(new Decimal(line.ratePerDay).times(line.quantity)),
    new Decimal(0)
  );

  const discount = input.discountPct ? new Decimal(input.discountPct).dividedBy(100) : null;
  if (discount && (discount.isNegative() || discount.greaterThanOrEqualTo(1))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A discount has to be between 0 and 100 per cent.');
  }

  const totalPerDay = discount
    ? subtotalPerDay.times(new Decimal(1).minus(discount))
    : subtotalPerDay;

  const grandTotal = lines.reduce((total, line) => {
    const lineRate = new Decimal(line.ratePerDay).times(line.quantity).times(line.days);
    return total.plus(discount ? lineRate.times(new Decimal(1).minus(discount)) : lineRate);
  }, new Decimal(0));

  /*
   * The discount is applied to the quote, but the floor is per line and per
   * day, so it has to be re-tested after the discount rather than before. A
   * quote that passes line by line and breaches once ten per cent comes off is
   * exactly the case the approvals queue exists for.
   */
  const belowFloor = lines.some((line) => {
    if (!line.floorPerDay) return false;
    const after = discount
      ? new Decimal(line.ratePerDay).times(new Decimal(1).minus(discount))
      : new Decimal(line.ratePerDay);
    return after.lessThan(new Decimal(line.floorPerDay));
  });

  return {
    lines,
    subtotalPerDay: money(subtotalPerDay),
    discountPct: input.discountPct ?? null,
    totalPerDay: money(totalPerDay),
    grandTotal: money(grandTotal),
    belowFloor,
    blocked,
    needsLegalApproval,
  };
}

/** QT-2609-4F2A1C. Short enough to read down a phone. */
async function nextReference(): Promise<string> {
  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = `QT-${stamp}-${randomBytes(3).toString('hex').toUpperCase()}`;
    if (!(await repository.referenceExists(reference))) return reference;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a quote reference.');
}

export async function saveQuote(input: BuildQuoteInput) {
  const priced = await priceQuote(input);

  return repository.createQuote({
    reference: await nextReference(),
    advertiserId: input.advertiserId ?? null,
    sector: input.sector ?? null,
    notes: input.notes ?? null,
    discountPct: input.discountPct
      ? new Decimal(input.discountPct).dividedBy(100)
      : null,
    subtotalPerDay: new Decimal(priced.subtotalPerDay),
    totalPerDay: new Decimal(priced.totalPerDay),
    grandTotal: new Decimal(priced.grandTotal),
    belowFloor: priced.belowFloor,
    createdById: input.createdById,
    expiresAt: input.expiresAt ?? null,
    lines: priced.lines.map((line) => ({
      listingId: line.listingId,
      mediaTypeId: line.mediaTypeId,
      grade: line.grade,
      cityId: line.cityId,
      label: line.label,
      quantity: line.quantity,
      days: line.days,
      rateCardId: line.rateCardId,
      cardRatePerDay: line.cardRatePerDay ? new Decimal(line.cardRatePerDay) : null,
      floorPerDay: line.floorPerDay ? new Decimal(line.floorPerDay) : null,
      ratePerDay: new Decimal(line.ratePerDay),
      lineTotal: new Decimal(line.lineTotal),
      trace: line.steps,
    })),
  });
}

export const listQuotes = (status?: string) => repository.listQuotes(status);

export async function getQuote(id: string) {
  const quote = await repository.findQuote(id);
  if (!quote) throw new ApiError(404, 'NOT_FOUND', 'Quote not found');
  return quote;
}

const NEXT: Record<string, string[]> = {
  DRAFT: ['SENT', 'WITHDRAWN'],
  SENT: ['ACCEPTED', 'EXPIRED', 'WITHDRAWN'],
  ACCEPTED: [],
  EXPIRED: [],
  WITHDRAWN: [],
};

export async function setQuoteStatus(id: string, status: string) {
  const quote = await getQuote(id);
  if (!NEXT[quote.status]?.includes(status)) {
    throw new ApiError(
      409,
      'CONFLICT',
      `A ${quote.status.toLowerCase()} quote cannot become ${status.toLowerCase()}.`
    );
  }
  return repository.setQuoteStatus(id, status);
}
