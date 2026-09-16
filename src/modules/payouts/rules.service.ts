import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import type { PartySizeBand, TaxParty } from '../../shared/database';

/**
 * The rules money has to obey before it can leave: how much, and how much of it
 * is the tax authority's.
 *
 * Every number here is a row rather than a constant. They have already changed
 * once during specification, and a threshold in a constant is a threshold that
 * needs a deployment to move.
 */

/* ------------------------------------------------------------------ */
/* Withdrawal limits                                                   */
/* ------------------------------------------------------------------ */

/**
 * The ladder, as given.
 *
 * A party sits on the row with the highest `minMonths` their tenure reaches, so
 * the ladder is read by finding the last rung they have climbed rather than by
 * a chain of conditionals that has to be edited to add a rung.
 */
export const DEFAULT_LIMITS: { band: PartySizeBand; minMonths: number; dailyCap: Money }[] = [
  { band: 'INDIVIDUAL', minMonths: 0, dailyCap: '5000.00' },
  { band: 'INDIVIDUAL', minMonths: 3, dailyCap: '10000.00' },
  { band: 'INDIVIDUAL', minMonths: 12, dailyCap: '50000.00' },

  { band: 'SMALL_AGENCY', minMonths: 0, dailyCap: '50000.00' },
  { band: 'SMALL_AGENCY', minMonths: 3, dailyCap: '100000.00' },
  { band: 'SMALL_AGENCY', minMonths: 12, dailyCap: '250000.00' },

  // Six months rather than three on the middle rung, as specified.
  { band: 'LARGE_AGENCY', minMonths: 0, dailyCap: '100000.00' },
  { band: 'LARGE_AGENCY', minMonths: 6, dailyCap: '250000.00' },
  { band: 'LARGE_AGENCY', minMonths: 12, dailyCap: '500000.00' },
];

/** The floor under a request. Not answered in the walkthrough; ₹500 proposed. */
export const DEFAULT_MINIMUM_WITHDRAWAL: Money = '500.00';

let limitsSeeded: Promise<void> | null = null;

export async function ensureLimits(): Promise<void> {
  limitsSeeded ??= (async () => {
    const existing = await repository.listLimits();
    if (existing.length > 0) return;
    for (const limit of DEFAULT_LIMITS) {
      await repository.upsertLimit({
        band: limit.band,
        minMonths: limit.minMonths,
        dailyCap: new Decimal(limit.dailyCap),
      });
    }
  })();
  await limitsSeeded;
}

/** Only for tests, which reset the module between cases. */
export function resetRulesCache(): void {
  limitsSeeded = null;
  taxSeeded = null;
}

/** Whole months between two dates, which is what a tenure ladder counts in. */
export function monthsBetween(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(months, 0);
}

export async function dailyCapFor(
  band: PartySizeBand,
  onboardedAt: Date,
  now = new Date()
): Promise<{ cap: Money; months: number; nextRung: { months: number; cap: Money } | null }> {
  await ensureLimits();
  const months = monthsBetween(onboardedAt, now);
  const rungs = (await repository.listLimits())
    .filter((limit) => limit.band === band)
    .sort((a, b) => a.minMonths - b.minMonths);

  if (rungs.length === 0) {
    throw new ApiError(500, 'INTERNAL_ERROR', `No withdrawal limit configured for ${band}`);
  }

  let current = rungs[0]!;
  for (const rung of rungs) if (months >= rung.minMonths) current = rung;

  const next = rungs.find((rung) => rung.minMonths > months);
  return {
    cap: money(current.dailyCap),
    months,
    // Worth returning: the screen can tell somebody what they are working
    // towards rather than only what they are stuck at.
    nextRung: next ? { months: next.minMonths, cap: money(next.dailyCap) } : null,
  };
}

/* ------------------------------------------------------------------ */
/* Tax withheld at source                                              */
/* ------------------------------------------------------------------ */

/**
 * Seeded at zero, deliberately.
 *
 * TDS was confirmed as something ADX deducts; the rates were not given. Zero
 * with the machinery in place means turning it on is a row, and every accrual
 * and withdrawal already carries the rate it was charged at — so switching it
 * on cannot re-rate money that has already moved. A default of "no deduction"
 * is also the only safe way to be wrong here.
 */
export const DEFAULT_TAX_RATES: {
  appliesTo: TaxParty;
  section: string;
  ratePct: Money;
  note: string;
}[] = [
  {
    appliesTo: 'PUBLISHER',
    section: '194C',
    ratePct: '0.00',
    note: 'Payments to contractors. Rate not yet confirmed — set before the first payout.',
  },
  {
    appliesTo: 'AGENT',
    section: '194H',
    ratePct: '0.00',
    note: 'Commission and brokerage. Rate not yet confirmed — set before the first payout.',
  },
  // Lot B (Q50/B4b): a print partner is a 194C contractor like a publisher.
  // The migration seeds the same row for a database that already had the
  // other two; this is for one that has none.
  {
    appliesTo: 'PARTNER',
    section: '194C',
    ratePct: '0.00',
    note: 'Print partners. Rate not yet confirmed — set before the first partner payout.',
  },
];

let taxSeeded: Promise<void> | null = null;

export async function ensureTaxRates(): Promise<void> {
  taxSeeded ??= (async () => {
    const existing = await repository.listTaxRates();
    if (existing.length > 0) return;
    for (const rate of DEFAULT_TAX_RATES) {
      await repository.createTaxRate({
        appliesTo: rate.appliesTo,
        section: rate.section,
        ratePct: new Decimal(rate.ratePct),
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
        note: rate.note,
      });
    }
  })();
  await taxSeeded;
}

export type Withholding = { taxWithheld: Money; ratePct: Money; section: string | null };

/** What to withhold from a gross amount, at the rate in force on a date. */
export async function withholdingFor(
  party: TaxParty,
  gross: Money,
  on = new Date()
): Promise<Withholding> {
  await ensureTaxRates();
  const rate = await repository.findTaxRate(party, on);
  if (!rate) return { taxWithheld: money(0), ratePct: money(0), section: null };

  const pct = new Decimal(rate.ratePct);
  return {
    // Rounded to paise the same way every other money figure is, so the row's
    // net = gross − commission − tax constraint holds exactly.
    taxWithheld: money(new Decimal(gross).times(pct).dividedBy(100)),
    ratePct: money(pct),
    section: rate.section,
  };
}

export const listTaxRates = () => repository.listTaxRates();
export const listLimits = async () => {
  await ensureLimits();
  return repository.listLimits();
};

export async function setTaxRate(input: {
  appliesTo: TaxParty;
  section: string;
  ratePct: Money;
  effectiveFrom: Date;
  note?: string | null;
}) {
  await ensureTaxRates();
  // Close the rate in force rather than editing it: a rate that changed is two
  // facts, and an accrual from last month must still be explicable.
  const current = await repository.findTaxRate(input.appliesTo, input.effectiveFrom);
  if (current) await repository.closeTaxRate(current.id, input.effectiveFrom);
  return repository.createTaxRate({
    appliesTo: input.appliesTo,
    section: input.section,
    ratePct: new Decimal(input.ratePct),
    effectiveFrom: input.effectiveFrom,
    note: input.note ?? null,
  });
}

export async function setLimit(input: {
  band: PartySizeBand;
  minMonths: number;
  dailyCap: Money;
}) {
  await ensureLimits();
  return repository.upsertLimit({
    band: input.band,
    minMonths: input.minMonths,
    dailyCap: new Decimal(input.dailyCap),
  });
}
