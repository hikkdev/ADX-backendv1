import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import type { RateGrade } from '../../shared/database';
import { effectiveCardEntry } from '../rate-cards';
import { installationFeeFor } from '../payouts';
import { activeSurge } from '../pricing';
import { quote as revenueQuote } from '../revenue';
import { prismaPriceModelRepository as repository } from './prisma-price-model.repository';
import {
  bandForArea,
  categoryRuleFor,
  dimensionValues,
  ruleMatches,
  type QuoteFacts,
} from './price-model.service';
import type { PriceRuleRow } from './price-model.repository';
import { durationDiscountFor, getSettings } from './settings.service';

/**
 * The price simulator: one real site, traced rule by rule to net to publisher.
 *
 * This is the DR 10 frame in code. Every row it draws has a source now:
 *
 *   Base rate ........... the approved rate card, at the site's grade
 *   Size band ........... the dimension whose range covers the measured area
 *   Illumination etc .... the dimension values the operator picked
 *   Locality grade ...... the grade the card priced (always 1.00x — the grade is
 *                         already in the base, and the row exists so the reader
 *                         sees it was considered)
 *   Category ............ the advertiser's sector rule
 *   Seasonality ......... the surge window over the site, if any
 *   Duration ............ the discount tier the flight length earns
 *   Subtotal ............ per-day rate x days x spots
 *   Negotiated discount . what was given away at the table
 *   Production .......... the fee schedule, from the revenue module
 *   Agent fee (cost) .... Lot B (Q134): what ADX pays the agent to put the
 *                         spot up, at the flat rate, printed beside the
 *                         advertiser's installation line with the margin
 *                         between them — read-only, never in the quote
 *   Taxable / GST / Gross the revenue module's per-line tax
 *   Platform commission . the publisher's commission, resolved by the revenue module
 *   Net to publisher .... what they are actually paid
 *
 * Everything from Subtotal down is the revenue module's arithmetic, called
 * rather than copied. Two implementations of GST is how a simulator and an
 * invoice come to disagree.
 *
 * TDS is not a row. Nothing in the platform models it yet; a row with an
 * invented 2% would be a claim about somebody's tax position that nothing
 * backs.
 */

export type SimulateInput = {
  listingId: string;
  days: number;
  spots?: number;
  sector?: string | null;
  /** Overrides the listing's own grade for what-if. */
  grade?: RateGrade | null;
  dimensionValueIds?: string[];
  /** A percentage, so "10" is ten per cent. */
  discountPct?: string | null;
  /** An unsaved rule to try alongside the live ones — the rule builder's preview. */
  previewRule?: {
    name: string;
    matchAny: boolean;
    adjustment: 'MULTIPLIER' | 'BASE_ADJUST' | 'OVERRIDE';
    value: string;
    conditions: { field: string; operator: string; value: string }[];
  } | null;
  at?: Date;
};

export type TraceRow = {
  step: string;
  rule: string;
  factor: string;
  running: Money;
  /** Drawn bold on the frame: the subtotal lines. */
  emphasis?: boolean;
};

export type Simulation = {
  listing: {
    id: string;
    title: string;
    city: string | null;
    /** Resolved from the listing's city name, so a saved quote prices from the same card. */
    cityId: string | null;
    mediaTypeId: string;
    mediaTypeName: string;
  };
  ratePerDay: Money;
  cardId: string | null;
  cardName: string | null;
  floorPerDay: Money | null;
  belowFloor: boolean;
  /** The discount the settings say needs sign-off, and whether this one does. */
  needsApproval: boolean;
  netToPublisher: Money;
  rows: TraceRow[];
  /**
   * Lot B (Q134): the installation, both sides — what the advertiser is
   * charged (the fee schedule line) and what ADX pays the agent (the flat
   * INSTALLATION rate × spots), with the margin between them. Null when the
   * bill carries no installation line or no agent rate is configured. A cost
   * line for the operator's eyes; nothing here changes the buyer's figure.
   */
  installation: { fee: Money; agentCost: Money; margin: Money } | null;
};

const DEFAULT_GRADE: RateGrade = 'B';

function applyRule(running: Decimal, rule: Pick<PriceRuleRow, 'adjustment' | 'value'>): Decimal {
  const value = new Decimal(rule.value);
  if (rule.adjustment === 'MULTIPLIER') return running.times(value);
  if (rule.adjustment === 'BASE_ADJUST') return running.plus(value);
  return value; // OVERRIDE
}

function factorLabel(rule: Pick<PriceRuleRow, 'adjustment' | 'value'>): string {
  const value = new Decimal(rule.value);
  if (rule.adjustment === 'MULTIPLIER') return `${value.toString()}×`;
  if (rule.adjustment === 'BASE_ADJUST') return `${value.isNegative() ? '' : '+'}${money(value)}`;
  return `= ${money(value)}`;
}

export async function simulate(input: SimulateInput): Promise<Simulation> {
  const at = input.at ?? new Date();
  const days = Math.max(1, Math.floor(input.days));
  const spots = Math.max(1, Math.floor(input.spots ?? 1));

  const listing = await repository.listingForSimulation(input.listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (!listing.mediaTypeId) {
    throw new ApiError(409, 'CONFLICT', 'This listing has no media type, so no card can price it.');
  }

  const settings = await getSettings();
  const grade: RateGrade = input.grade ?? (listing.rateGrade as RateGrade | null) ?? DEFAULT_GRADE;
  const sector = input.sector?.trim() || null;

  const found = await effectiveCardEntry(listing.mediaTypeId, grade, listing.cityId, at);
  if (!found?.entry.ratePerDay) {
    throw new ApiError(
      409,
      'CONFLICT',
      `No approved rate card prices ${listing.mediaTypeName} at grade ${grade}, so there is no base rate to trace from.`
    );
  }

  const rows: TraceRow[] = [];
  const base = new Decimal(found.entry.ratePerDay);
  let running = base;
  const push = (step: string, rule: string, factor: string, emphasis = false) =>
    rows.push({ step, rule, factor, running: money(running), emphasis });

  push('Base rate', `${found.card.name} v${found.card.version}`, `${money(base)} / day`);

  // Size band, from the measurement.
  if (listing.areaSqFt) {
    const band = await bandForArea(new Decimal(listing.areaSqFt).toFixed(2));
    if (band) {
      running = running.times(new Decimal(band.value.multiplier));
      push(
        band.dimension.name,
        `${band.value.label} · ${new Decimal(listing.areaSqFt).toFixed(0)} sq ft`,
        `${new Decimal(band.value.multiplier).toString()}×`
      );
    }
  }

  // The dimensions the operator picked.
  for (const value of await dimensionValues(input.dimensionValueIds ?? [])) {
    running = running.times(value.multiplier);
    push(value.dimensionName, value.label, `${value.multiplier.toString()}×`);
  }

  // The grade is already inside the base; the row shows it was considered.
  push('Locality grade', `Grade ${grade}`, '1.00×');

  // The advertiser's sector.
  if (sector) {
    const rule = await categoryRuleFor(sector, listing.mediaTypeId);
    if (rule?.effect === 'BLOCKED') {
      throw new ApiError(
        409,
        'CONFLICT',
        `${rule.sector} may not book ${listing.mediaTypeName}. Change the rule, or the sector.`
      );
    }
    if (rule?.effect === 'MULTIPLIER' && rule.multiplier) {
      running = running.times(new Decimal(rule.multiplier));
      push('Category', `${rule.sector} on ${listing.mediaTypeName}`, `${new Decimal(rule.multiplier).toString()}×`);
    } else {
      push('Category', rule ? `${rule.sector} · needs sign-off` : `${sector} · no rule`, '1.00×');
    }
  }

  // Seasonality: the surge window over this site, if one is in force.
  const surge = listing.latitude !== null && listing.longitude !== null
    ? await activeSurge(
        { latitude: listing.latitude, longitude: listing.longitude, city: listing.city },
        at
      )
    : null;
  if (surge) {
    // The calendar reports an uplift percentage; the trace draws a factor.
    const factor = new Decimal(100).plus(surge.upliftPct).dividedBy(100);
    running = running.times(factor);
    push('Seasonality', surge.name ?? 'Confidential window', `${factor.toDecimalPlaces(4).toString()}×`);
  } else {
    push('Seasonality', 'No active window', '1.00×');
  }

  // Rules, live plus the one being previewed.
  const facts: QuoteFacts = {
    mediaTypeId: listing.mediaTypeId,
    grade,
    city: listing.city,
    sector,
    areaSqFt: listing.areaSqFt ? new Decimal(listing.areaSqFt).toFixed(2) : null,
    days,
  };
  const live = (await repository.rulesInForce(at)).filter((rule) => ruleMatches(rule, facts));
  const previewed: PriceRuleRow[] = input.previewRule
    ? [
        {
          id: 'preview',
          name: `${input.previewRule.name} (unsaved)`,
          description: null,
          priority: Number.MAX_SAFE_INTEGER,
          matchAny: input.previewRule.matchAny,
          adjustment: input.previewRule.adjustment,
          value: new Decimal(input.previewRule.value) as never,
          startsAt: null,
          endsAt: null,
          isActive: true,
          conditions: input.previewRule.conditions.map((c, i) => ({ id: `p${i}`, ...c })),
        },
      ].filter((rule) => ruleMatches(rule, facts))
    : [];

  for (const rule of [...live, ...previewed]) {
    running = applyRule(running, rule);
    push(rule.adjustment === 'OVERRIDE' ? 'Override' : 'Rule', rule.name, factorLabel(rule));
  }

  // Duration discount, from the settings ladder.
  const tier = durationDiscountFor(days, settings.durationDiscounts);
  if (tier && tier.pct > 0) {
    running = running.times(new Decimal(100).minus(tier.pct).dividedBy(100));
    push('Duration', `${days}-day flight · ${tier.minDays}+ day tier`, `−${tier.pct}%`);
  } else {
    push('Duration', `${days}-day flight`, '0%');
  }

  // Rounding, then the minimum.
  const rounding = new Decimal(settings.roundingRupees);
  if (rounding.greaterThan(0)) {
    const rounded = running.dividedBy(rounding).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(rounding);
    if (!rounded.equals(running)) {
      running = rounded;
      push('Rounding', `Nearest ₹${settings.roundingRupees}`, '—');
    }
  }
  const minimum = new Decimal(settings.minimumRatePerDay);
  if (minimum.greaterThan(0) && running.lessThan(minimum)) {
    running = minimum;
    push('Minimum rate', 'Rate basis floor', `= ${money(minimum)}`);
  }

  const ratePerDay = running;
  const floor = base.times(new Decimal(found.card.floorPct));

  // The negotiated discount, as a rupee amount off the media value — which is
  // how the revenue module takes it.
  const discountPct = input.discountPct ? new Decimal(input.discountPct) : new Decimal(0);
  if (discountPct.isNegative() || discountPct.greaterThanOrEqualTo(100)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A discount has to be between 0 and 100 per cent.');
  }
  const mediaValue = ratePerDay.times(days).times(spots);
  const rateDiscount = mediaValue.times(discountPct).dividedBy(100);

  // From here down the revenue module does the arithmetic.
  const bill = await revenueQuote({
    listingId: listing.id,
    days,
    spots,
    ratePerDay: money(ratePerDay),
    rateDiscount: rateDiscount.greaterThan(0) ? money(rateDiscount) : undefined,
    at,
  });

  running = mediaValue;
  push(`Subtotal (${days} days${spots > 1 ? ` × ${spots}` : ''})`, `${money(ratePerDay)} / day`, `× ${days}${spots > 1 ? ` × ${spots}` : ''}`, true);

  if (rateDiscount.greaterThan(0)) {
    running = running.minus(rateDiscount);
    push('Negotiated discount', discountPct.greaterThanOrEqualTo(new Decimal(settings.approvalThresholdPct)) ? 'Needs approval' : 'Within threshold', `−${discountPct.toString()}%`);
  }

  // Q134: the agent's installation fee is a cost of sales, not a fee line.
  // Read at the flat rate — the simulator has no order to carry a per-order
  // figure — and printed beside the advertiser's installation line without
  // touching the running total. A rate that cannot be read prints nothing.
  const agentFee = await installationFeeFor({ agentFeeAmount: null }, '*', at).catch(() => null);
  let installation: Simulation['installation'] = null;

  for (const line of bill.lines) {
    if (line.kind === 'MEDIA') continue;
    running = running.plus(new Decimal(line.taxableValue));
    push(line.label, 'Fee schedule', `+${line.taxableValue}`);
    if (line.kind === 'INSTALLATION' && agentFee !== null) {
      const agentCost = new Decimal(agentFee).times(spots);
      const margin = new Decimal(line.taxableValue).minus(agentCost);
      installation = { fee: line.taxableValue, agentCost: money(agentCost), margin: money(margin) };
      push('Agent installation fee (cost)', `Flat rate · not billed${spots > 1 ? ` · × ${spots}` : ''}`, `(${money(agentCost)})`);
      push('Installation margin', 'Fee less agent cost', `${margin.isNegative() ? '−' : '+'}${money(margin.abs())}`);
    }
  }

  running = new Decimal(bill.netValue);
  push('Taxable value', 'All lines, before tax', '', true);

  running = running.plus(new Decimal(bill.gstAmount));
  push('GST', 'Per line, from tax settings', `+${bill.gstAmount}`);

  running = new Decimal(bill.grossTotal);
  push('Gross payable', 'Advertiser invoice', '', true);

  // The trace crosses sides here: everything above is what the advertiser
  // pays, everything below what the publisher keeps. The running figure
  // follows the publisher, so it drops by the commission rather than to it.
  running = new Decimal(bill.publisher.netEarnings);
  push(
    `Platform commission ${new Decimal(bill.publisher.commissionPct).times(100).toFixed(0)}%`,
    `On media value · ${bill.publisher.commissionSource.toLowerCase().replace(/_/g, ' ')}`,
    `−${bill.publisher.commissionAmount}`
  );

  push('Net to publisher', 'After commission', '', true);

  const belowFloor = settings.floorProtection && ratePerDay.times(new Decimal(100).minus(discountPct).dividedBy(100)).lessThan(floor);

  return {
    listing: {
      id: listing.id,
      title: listing.title,
      city: listing.city,
      cityId: listing.cityId,
      mediaTypeId: listing.mediaTypeId,
      mediaTypeName: listing.mediaTypeName,
    },
    ratePerDay: money(ratePerDay),
    cardId: found.card.id,
    cardName: `${found.card.name} v${found.card.version}`,
    floorPerDay: money(floor),
    belowFloor,
    needsApproval:
      belowFloor || discountPct.greaterThanOrEqualTo(new Decimal(settings.approvalThresholdPct)),
    netToPublisher: bill.publisher.netEarnings,
    rows,
    installation,
  };
}
