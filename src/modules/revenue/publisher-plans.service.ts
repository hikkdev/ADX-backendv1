import { randomInt } from 'crypto';
import type { Request } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import type { PackageBillingCycle, Prisma, PublisherSubscription, SubscriptionTierName } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage } from '../../shared/pagination';
import { getSubscriptionPolicy, type SubscriptionPolicy } from '../app-config';
import { notify } from '../notifications';
import { ensureWallet, move, snapshot } from '../wallets';
import { prismaPublisherPlansRepository as repository } from './prisma-publisher-plans.repository';
import { prismaRevenueRepository as revenueRepository } from './prisma-revenue.repository';
import type { OrderRow, PlanRow, SubscriptionListFilter } from './publisher-plans.repository';
import { taxSettings } from './revenue.service';

/**
 * Publisher subscription plans and self-service orders — Lot J (B1), the
 * owner's decision of 14 Sep 2026: "add the plans and prices section with
 * default pricing for now; a control in the admin panel to change and
 * control the subscription plans and features for both user types".
 *
 * The shape mirrors `packages` deliberately. A plan is a catalogue row ops
 * reprice without a deploy; an order is a snapshot of that row at the moment
 * the publisher chose it; and payment turns the order into the
 * `PublisherSubscription` the commission ladder already reads. Nothing sold
 * is ever re-rated by an edit — the subscription keeps its own copy of the
 * price and the rate, exactly as the admin grant always has.
 *
 * Lot J2 (the owner, 14 Sep 2026): the purchase rules are configuration —
 * `settings.subscriptions.publisher` (`app-config`), read on every quote,
 * activation and sweep: the cycles offered and the annual discount, what a
 * different tier does to the running one (replace now, with or without a
 * proration credit, or queue after the term), a grace window on the
 * entitlements, per-tier free trials, the reminder lead, the unpaid-order
 * expiry, which rails may pay, and auto-renew from the wallet. GST is not
 * a policy field: both pricing paths read revenue's own tax row.
 */

export type Tier = SubscriptionTierName;
export type Cycle = PackageBillingCycle;

/* ------------------------------------------------------------------ */
/* The defaults                                                        */
/* ------------------------------------------------------------------ */

/** The platform default commission when revenue has no null-category row to read. */
export const FALLBACK_COMMISSION_PCT = '0.15';
/** No tier ever grants a take below this, whatever the default is edited to. */
export const MIN_TIER_RATE_PCT = '0.05';

/** What each tier knocks off the platform default commission. */
export const TIER_RATE_DISCOUNTS: Record<Tier, string> = {
  STANDARD: '0.01',
  PLUS: '0.025',
  PRO: '0.05',
};

export const DEFAULT_PLANS: readonly {
  tier: Tier;
  name: string;
  pricePerMonth: Money;
  description: string;
  isPopular: boolean;
  sortOrder: number;
  entitlements: Record<string, unknown>;
}[] = [
  {
    tier: 'STANDARD',
    name: 'Standard',
    pricePerMonth: '999',
    description: 'A lower take on every booking, and the monthly booking report.',
    isPopular: false,
    sortOrder: 1,
    entitlements: { liveChat: false, prioritySupport: false, featuredListings: 0, analytics: 'BASIC', bookingReportPdf: true },
  },
  {
    tier: 'PLUS',
    name: 'Plus',
    pricePerMonth: '2499',
    description: 'Live chat with ADX, a featured listing and advanced analytics.',
    isPopular: true,
    sortOrder: 2,
    entitlements: { liveChat: true, prioritySupport: false, featuredListings: 1, analytics: 'ADVANCED', bookingReportPdf: true },
  },
  {
    tier: 'PRO',
    name: 'Pro',
    pricePerMonth: '4999',
    description: 'The lowest take, priority support and three featured listings.',
    isPopular: false,
    sortOrder: 3,
    entitlements: { liveChat: true, prioritySupport: true, featuredListings: 3, analytics: 'ADVANCED', bookingReportPdf: true },
  },
];

/** The one entitlement a rule reads (`support`'s live-chat gate); the rest is copy. */
export const ENFORCED_ENTITLEMENT_KEYS = ['liveChat'] as const;

/**
 * The shipped annual discount — the SAVE 20% badge. Since Lot J2 the live
 * number is `settings.subscriptions.publisher.annualDiscountPct`; this is
 * what that setting defaults to, kept for the tests that pin the badge.
 */
export const ANNUAL_DISCOUNT_PCT = 20;
export const ANNUAL_MONTHS = 12;

/**
 * The shipped defaults of the two sweep windows. Since Lot J2 the live
 * numbers are `unpaidOrderExpiryDays` and `reminderLeadDays` on the policy.
 */
export const ORDER_TTL_DAYS = 7;
export const EXPIRING_NOTICE_DAYS = 7;

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

/**
 * The rate a tier grants: the platform default less the tier's discount,
 * floored at `MIN_TIER_RATE_PCT`. Four decimal places, the column's own.
 */
export function tierRate(defaultRatePct: Money, tier: Tier): string {
  const rate = new Decimal(defaultRatePct).minus(new Decimal(TIER_RATE_DISCOUNTS[tier]));
  return Decimal.max(rate, new Decimal(MIN_TIER_RATE_PCT)).toFixed(4);
}

/** The platform default commission as revenue's own null-category row has it, or the fallback. */
async function platformDefaultCommission(): Promise<string> {
  const rows = await revenueRepository.listCommissionRates();
  const row = rows.find((rate) => rate.isActive && rate.category === null && rate.mediaTypeId === null);
  return row ? new Decimal(row.ratePct).toString() : FALLBACK_COMMISSION_PCT;
}

/** Creates the three plans if the catalogue is empty. Idempotent, safe per request. */
export async function ensurePlans(): Promise<void> {
  const existing = await repository.listPlans(true);
  if (existing.length > 0) return;
  const defaultRate = await platformDefaultCommission();
  for (const plan of DEFAULT_PLANS) {
    await repository.upsertPlan({
      tier: plan.tier,
      name: plan.name,
      pricePerMonth: new Decimal(plan.pricePerMonth),
      ratePct: new Decimal(tierRate(defaultRate, plan.tier)),
      description: plan.description,
      isPopular: plan.isPopular,
      entitlements: plan.entitlements as Prisma.InputJsonValue,
      sortOrder: plan.sortOrder,
    });
  }
}

export type PlanView = {
  id: string;
  tier: Tier;
  name: string;
  pricePerMonth: Money;
  /** A fraction — 0.1250. */
  ratePct: string;
  description: string | null;
  isPopular: boolean;
  entitlements: unknown;
  /** The JSON as a whole is copy, not a gate; these keys are the ones a rule reads. */
  enforced: false;
  enforcedKeys: readonly string[];
  isActive: boolean;
  sortOrder: number;
};

export const planView = (plan: PlanRow): PlanView => ({
  id: plan.id,
  tier: plan.tier,
  name: plan.name,
  pricePerMonth: money(plan.pricePerMonth),
  ratePct: new Decimal(plan.ratePct).toFixed(4),
  description: plan.description,
  isPopular: plan.isPopular,
  entitlements: plan.entitlements,
  enforced: false,
  enforcedKeys: ENFORCED_ENTITLEMENT_KEYS,
  isActive: plan.isActive,
  sortOrder: plan.sortOrder,
});

export async function listPlans(options: { includeInactive?: boolean | undefined } = {}): Promise<PlanView[]> {
  await ensurePlans();
  const rows = await repository.listPlans(options.includeInactive === true);
  return rows.map(planView);
}

export async function findPlan(tier: Tier): Promise<PlanRow | null> {
  await ensurePlans();
  return repository.findPlan(tier);
}

export type PlanByTier = { tier: Tier; name: string; entitlements: unknown; isActive: boolean };

/**
 * Every tier's plan in one query — what `support`'s live-chat entitlement
 * reads so a page of chats costs one read, not one per row. Retired plans
 * are included: a subscription sold under a plan since retired is still
 * bound by what that plan promised.
 */
export async function publisherPlansByTier(): Promise<Map<Tier, PlanByTier>> {
  await ensurePlans();
  const out = new Map<Tier, PlanByTier>();
  for (const plan of await repository.listPlans(true)) {
    out.set(plan.tier, { tier: plan.tier, name: plan.name, entitlements: plan.entitlements, isActive: plan.isActive });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The editor                                                          */
/* ------------------------------------------------------------------ */

type Editor = { userId: string; req?: Request | undefined };

/**
 * Ops reprice, re-rate and rename without a deploy. A subscription already
 * sold keeps the copies it was made with, so an edit only ever changes the
 * next order; and entitlements stay copy save `liveChat`, which `support`
 * reads. Audited with the diff on the money, the rate and the switches.
 */
export async function updatePlan(
  tier: Tier,
  patch: {
    name?: string | undefined;
    pricePerMonth?: string | undefined;
    ratePct?: string | undefined;
    description?: string | null | undefined;
    entitlements?: Record<string, unknown> | undefined;
    isPopular?: boolean | undefined;
    isActive?: boolean | undefined;
    sortOrder?: number | undefined;
  },
  editor: Editor,
): Promise<PlanView> {
  await ensurePlans();
  const before = await repository.findPlan(tier);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Plan not found');

  if (patch.ratePct !== undefined) {
    const rate = new Decimal(patch.ratePct);
    if (rate.lessThan(0) || rate.greaterThan(1)) {
      throw new ApiError(400, 'BAD_REQUEST', 'A commission rate is a fraction between 0 and 1 — 0.12 is twelve percent, not 12');
    }
  }

  const after = await repository.updatePlan(tier, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.pricePerMonth !== undefined ? { pricePerMonth: new Decimal(patch.pricePerMonth) } : {}),
    ...(patch.ratePct !== undefined ? { ratePct: new Decimal(patch.ratePct) } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.entitlements !== undefined ? { entitlements: patch.entitlements as Prisma.InputJsonValue } : {}),
    ...(patch.isPopular !== undefined ? { isPopular: patch.isPopular } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
  });

  const audited = (plan: PlanRow) => ({
    name: plan.name,
    pricePerMonth: money(plan.pricePerMonth),
    ratePct: new Decimal(plan.ratePct).toFixed(4),
    description: plan.description,
    entitlements: plan.entitlements,
    isPopular: plan.isPopular,
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
  });
  await logActivity(editor.userId, 'PUBLISHER_PLAN_UPDATED', {
    req: editor.req,
    module: 'revenue',
    targetType: 'PublisherSubscriptionPlan',
    targetId: after.id,
    diff: auditDiff(audited(before), audited(after)),
    metadata: { tier },
  });
  return planView(after);
}

/* ------------------------------------------------------------------ */
/* The policy and the rates                                            */
/* ------------------------------------------------------------------ */

/** What both pricing paths need beside the price: GST as a percent (the tax row), the annual discount (the policy). */
export type PricingRates = { gstPct: Money | number; annualDiscountPct: Money | number };

/** A fraction (`0.18`, the tax row's column) as the percent the order stores (`18`). */
export const fractionToPercent = (fraction: Money): string => new Decimal(fraction).times(100).toString();

/** Lot J2: the live rates — GST from revenue's tax row, the discount from the audience's policy. */
export async function subscriptionRates(policy: SubscriptionPolicy): Promise<PricingRates> {
  const tax = await taxSettings();
  return { gstPct: fractionToPercent(tax.mediaGstPct), annualDiscountPct: policy.annualDiscountPct };
}

/** Lot J2: a cycle the policy does not offer is refused before anything is priced, naming the ones it does. */
export function assertCycleOffered(cycle: Cycle, policy: Pick<SubscriptionPolicy, 'cyclesOffered'>): void {
  if (policy.cyclesOffered.includes(cycle)) return;
  throw new ApiError(400, 'CYCLE_NOT_OFFERED', `The ${cycle} cycle is not offered. Choose ${policy.cyclesOffered.join(' or ')}.`, {
    cycle,
    cyclesOffered: policy.cyclesOffered,
  });
}

/** The rules the phone prints beside a quote without computing them. */
export type PolicyView = {
  cyclesOffered: readonly Cycle[];
  annualDiscountPct: number;
  changePolicy: SubscriptionPolicy['changePolicy'];
  prorateOnChange: boolean;
  graceDays: number;
  /** For the asked tier. */
  trialDays: number;
  payment: { walletAllowed: boolean; gatewaysAllowed: readonly string[] };
  autoRenewAllowed: boolean;
};

export const policyView = (policy: SubscriptionPolicy, tier: string): PolicyView => ({
  cyclesOffered: policy.cyclesOffered,
  annualDiscountPct: policy.annualDiscountPct,
  changePolicy: policy.changePolicy,
  prorateOnChange: policy.prorateOnChange,
  graceDays: policy.graceDays,
  trialDays: policy.trialDays[tier] ?? 0,
  payment: { walletAllowed: policy.payment.walletAllowed, gatewaysAllowed: policy.payment.gatewaysAllowed },
  autoRenewAllowed: policy.autoRenew.allowed,
});

const publisherPolicy = (): Promise<SubscriptionPolicy> => getSubscriptionPolicy('publisher');

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

export type PricedSubscription = {
  cycle: Cycle;
  months: number;
  pricePerMonth: Money;
  subtotal: Money;
  discountPct: Money;
  discountAmount: Money;
  gstPct: Money;
  gstAmount: Money;
  total: Money;
};

/**
 * What a tier costs for a cycle. Pure — the rates come in, so the quote and
 * the order cannot disagree, and neither can a test that pins the badge.
 */
export function priceSubscription(input: { pricePerMonth: Money; cycle: Cycle; rates: PricingRates }): PricedSubscription {
  const months = input.cycle === 'ANNUAL' ? ANNUAL_MONTHS : 1;
  const perMonth = new Decimal(input.pricePerMonth);
  const subtotal = perMonth.times(months);
  const discountPct = input.cycle === 'ANNUAL' ? new Decimal(input.rates.annualDiscountPct) : new Decimal(0);
  const discountAmount = subtotal.times(discountPct).dividedBy(100);
  const taxable = subtotal.minus(discountAmount);
  const gstPct = new Decimal(input.rates.gstPct);
  const gstAmount = taxable.times(gstPct).dividedBy(100);
  return {
    cycle: input.cycle,
    months,
    pricePerMonth: money(perMonth),
    subtotal: money(subtotal),
    discountPct: money(discountPct),
    discountAmount: money(discountAmount),
    gstPct: money(gstPct),
    gstAmount: money(gstAmount),
    total: money(taxable.plus(gstAmount)),
  };
}

/* ------------------------------------------------------------------ */
/* The term rule                                                       */
/* ------------------------------------------------------------------ */

export type TermRule = 'STARTS_NOW' | 'QUEUED_AFTER_CURRENT' | 'REPLACES_CURRENT';

/** Lot J2: the unused days of a replaced term, as the wallet credit the activation posts. */
export type ProrationCredit = { subscriptionId: string; planName: string } & Proration;

/** Lot K (B2): what a replaced term gives back — never more than it paid. */
export type Proration = {
  amount: Money;
  /** Whole days left on the term at the switch. */
  remainingDays: number;
  /** The term's whole length in days — the divisor, never the month's. */
  termDays: number;
  /** The linked order's total, the ceiling. */
  paidTotal: Money;
};

export type Term = {
  rule: TermRule;
  startsAt: Date;
  endsAt: Date;
  /** The different-tier subscription that stops the moment this one is paid. */
  replaces: { id: string; tier: Tier; endsAt: Date | null } | null;
  /** Lot J2: what the replaced term gives back, under REPLACE_NOW with `prorateOnChange`; null otherwise. */
  credit: ProrationCredit | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const addMonths = (from: Date, months: number): Date => {
  const to = new Date(from);
  const day = to.getUTCDate();
  to.setUTCMonth(to.getUTCMonth() + months);
  // A 31st that lands in a short month rolls back rather than into the next one.
  if (to.getUTCDate() < day) to.setUTCDate(0);
  return to;
};

/**
 * Lot J2 / K (B2): the proration credit — what the replaced term actually
 * paid (`paidTotal`, the linked order's or sale's total) × the whole days
 * left on it ÷ the term's own whole length in days, rounded down to the
 * paisa and never above `paidTotal`. The divisor is the term, not the
 * month `now` falls in: an annual term paid at a discount gives back a
 * share of what was paid for it, never twelve months of list price. Null
 * for an open-ended term (nothing unused to measure), when no whole day is
 * left, and — the cap at its plainest — for a term that paid nothing: a
 * TRIAL, or an admin grant with no order behind it.
 */
export function prorationAmount(term: { paidTotal: Prisma.Decimal | Money | null; startsAt: Date; endsAt: Date | null }, now: Date): Proration | null {
  if (term.paidTotal === null || !term.endsAt || term.endsAt <= now) return null;
  const paid = new Decimal(term.paidTotal);
  if (paid.lessThanOrEqualTo(0)) return null;
  const termDays = Math.floor((term.endsAt.getTime() - term.startsAt.getTime()) / DAY_MS);
  const remainingDays = Math.floor((term.endsAt.getTime() - now.getTime()) / DAY_MS);
  if (termDays <= 0 || remainingDays <= 0) return null;
  const share = paid.times(Math.min(remainingDays, termDays)).dividedBy(termDays).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const amount = Decimal.min(share, paid);
  if (amount.lessThanOrEqualTo(0)) return null;
  return { amount: money(amount), remainingDays, termDays, paidTotal: money(paid) };
}

/** Lot K (B2): a subscription is a trial when the order that made it was paid by TRIAL; an admin grant has no order and is never one. */
const isTrialOrder = (order: { paidMethod: string | null } | null | undefined): boolean => order?.paidMethod === 'TRIAL';

/** The ceiling on a replaced subscription's credit: its order's total, or nothing for a trial or a grant with no order. */
const paidTotalOf = (order: OrderRow | null): Prisma.Decimal | null => (order && !isTrialOrder(order) ? order.total : null);

/**
 * When a bought term starts:
 *
 *  - nothing running → now;
 *  - the same tier running with an end → at that end (a renewal queues);
 *  - the same tier running open-ended (an admin grant with no end) → refused,
 *    409 `ALREADY_ON_PLAN`: there is nothing to renew and nothing to replace;
 *  - a different tier running → the policy decides (Lot J2): REPLACE_NOW
 *    starts now and the running one ends now — with the unused days
 *    credited to the wallet when `prorateOnChange` is on — and
 *    QUEUE_AFTER_TERM starts at the running term's end, like a same-tier
 *    renewal (refused when that term has no end).
 *
 * Asked at the quote, at the order and again at payment, so the answer the
 * publisher was shown is the answer the activation applies.
 */
export async function resolveTerm(publisherId: string, tier: Tier, months: number, now: Date, policy?: SubscriptionPolicy): Promise<Term> {
  const running = await revenueRepository.findRunningSubscription(publisherId, now);
  if (!running) {
    return { rule: 'STARTS_NOW', startsAt: now, endsAt: addMonths(now, months), replaces: null, credit: null };
  }
  if (running.tier === tier) {
    if (running.endsAt === null) {
      throw new ApiError(409, 'ALREADY_ON_PLAN', 'Already on this plan');
    }
    return { rule: 'QUEUED_AFTER_CURRENT', startsAt: running.endsAt, endsAt: addMonths(running.endsAt, months), replaces: null, credit: null };
  }
  const rules = policy ?? (await publisherPolicy());
  if (rules.changePolicy === 'QUEUE_AFTER_TERM') {
    if (running.endsAt === null) {
      throw new ApiError(409, 'ALREADY_ON_PLAN', 'Your current plan has no end date, so a different plan cannot be queued after it. Ask ADX to end it first.');
    }
    return { rule: 'QUEUED_AFTER_CURRENT', startsAt: running.endsAt, endsAt: addMonths(running.endsAt, months), replaces: null, credit: null };
  }
  // Lot K (B2): the credit is capped at what the running term's order paid — a trial or a grant with no order earns none.
  const proration = rules.prorateOnChange
    ? prorationAmount({ paidTotal: paidTotalOf(await repository.findOrderBySubscription(running.id)), startsAt: running.startsAt, endsAt: running.endsAt }, now)
    : null;
  const plans = proration ? await publisherPlansByTier() : null;
  return {
    rule: 'REPLACES_CURRENT',
    startsAt: now,
    endsAt: addMonths(now, months),
    replaces: { id: running.id, tier: running.tier, endsAt: running.endsAt },
    credit: proration ? { subscriptionId: running.id, planName: plans?.get(running.tier)?.name ?? titleCase(running.tier), ...proration } : null,
  };
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export type OrderActor = { userId: string; isAdmin: boolean; publisherId: string | null };

export type OrderView = {
  id: string;
  reference: string;
  publisherId: string;
  publisherName: string;
  tier: Tier;
  planName: string;
  cycle: Cycle;
  months: number;
  pricePerMonth: Money;
  ratePct: string;
  subtotal: Money;
  discountPct: Money;
  discountAmount: Money;
  gstPct: Money;
  gstAmount: Money;
  total: Money;
  status: OrderRow['status'];
  startsAt: Date | null;
  paidAt: Date | null;
  paidMethod: string | null;
  paidReference: string | null;
  cancelledAt: Date | null;
  subscriptionId: string | null;
  createdAt: Date;
};

export const orderView = (order: OrderRow): OrderView => ({
  id: order.id,
  reference: order.reference,
  publisherId: order.publisherId,
  publisherName: order.publisher.name,
  tier: order.tier,
  planName: order.planName,
  cycle: order.cycle,
  months: order.months,
  pricePerMonth: money(order.pricePerMonth),
  ratePct: new Decimal(order.ratePct).toFixed(4),
  subtotal: money(order.subtotal),
  discountPct: money(order.discountPct),
  discountAmount: money(order.discountAmount),
  gstPct: money(order.gstPct),
  gstAmount: money(order.gstAmount),
  total: money(order.total),
  status: order.status,
  startsAt: order.startsAt,
  paidAt: order.paidAt,
  paidMethod: order.paidMethod,
  paidReference: order.paidReference,
  cancelledAt: order.cancelledAt,
  subscriptionId: order.subscriptionId,
  createdAt: order.createdAt,
});

/**
 * SUB-2026-482913. Minted the way `packages` and `payments` mint theirs: the
 * identifiers service issues day-sequenced ids keyed on the `PartyType`
 * enum, and a new series there is a schema change this lot may not make.
 */
async function nextReference(now: Date): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const reference = `SUB-${now.getUTCFullYear()}-${String(randomInt(1, 999_999)).padStart(6, '0')}`;
    if (!(await repository.referenceExists(reference))) return reference;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a subscription reference');
}

async function activePlanOrThrow(tier: Tier): Promise<PlanRow> {
  const plan = await findPlan(tier);
  if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Plan not found');
  if (!plan.isActive) throw new ApiError(409, 'CONFLICT', `The ${plan.name} plan is not on sale`);
  return plan;
}

export type SubscriptionQuote = PricedSubscription & {
  plan: PlanView;
  term: Term;
  /** Lot J2: the rules the phone prints beside the money. */
  policy: PolicyView;
};

/** What a tier costs this publisher for a cycle, and when the term would start. */
export async function quoteSubscriptionOrder(input: { publisherId: string; tier: Tier; cycle: Cycle; now?: Date }): Promise<SubscriptionQuote> {
  const now = input.now ?? new Date();
  const policy = await publisherPolicy();
  assertCycleOffered(input.cycle, policy);
  const plan = await activePlanOrThrow(input.tier);
  const priced = priceSubscription({ pricePerMonth: money(plan.pricePerMonth), cycle: input.cycle, rates: await subscriptionRates(policy) });
  const term = await resolveTerm(input.publisherId, input.tier, priced.months, now, policy);
  return { ...priced, plan: planView(plan), term, policy: policyView(policy, input.tier) };
}

/** The order — a snapshot of the plan at the moment it was chosen. */
export async function createSubscriptionOrder(input: {
  publisherId: string;
  userId: string;
  tier: Tier;
  cycle: Cycle;
  now?: Date;
}): Promise<{ order: OrderView; term: Term }> {
  const now = input.now ?? new Date();
  const quote = await quoteSubscriptionOrder({ publisherId: input.publisherId, tier: input.tier, cycle: input.cycle, now });
  const plan = await activePlanOrThrow(input.tier);
  const order = await repository.createOrder({
    reference: await nextReference(now),
    publisherId: input.publisherId,
    createdByUserId: input.userId,
    tier: plan.tier,
    planName: plan.name,
    pricePerMonth: new Decimal(plan.pricePerMonth),
    ratePct: new Decimal(plan.ratePct),
    cycle: quote.cycle,
    months: quote.months,
    subtotal: new Decimal(quote.subtotal),
    discountPct: new Decimal(quote.discountPct),
    discountAmount: new Decimal(quote.discountAmount),
    gstPct: new Decimal(quote.gstPct),
    gstAmount: new Decimal(quote.gstAmount),
    total: new Decimal(quote.total),
    startsAt: quote.term.startsAt,
  });
  return { order: orderView(order), term: quote.term };
}

/** For the payments lane: the raw row, or null. */
export const findSubscriptionOrder = (id: string): Promise<OrderRow | null> => repository.findOrder(id);

/** The order, for whoever may see it: the publisher who owns it, or an ADMIN. */
export async function getSubscriptionOrder(id: string, actor: OrderActor): Promise<OrderRow> {
  const order = await repository.findOrder(id);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Subscription order not found');
  if (!actor.isAdmin && order.publisherId !== actor.publisherId) {
    throw new ApiError(403, 'FORBIDDEN', 'This order belongs to someone else.');
  }
  return order;
}

/** Only the publisher who owns the order pays from the wallet — not an admin acting as them. */
export function assertMayPaySubscriptionOrder(order: { publisherId: string }, actor: OrderActor): void {
  if (!actor.publisherId || actor.publisherId !== order.publisherId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the publisher can pay for their own subscription.');
  }
}

/**
 * Whether the order can still take money. Asked before the wallet is
 * touched: `markSubscriptionOrderPaid` refuses too, but in a second
 * transaction, by which point the money has moved.
 */
export function assertSubscriptionOrderPayable(order: { status: OrderRow['status'] }): void {
  if (order.status === 'CANCELLED') throw new ApiError(409, 'CONFLICT', 'This order was cancelled and cannot be paid.');
  if (order.status === 'EXPIRED') throw new ApiError(409, 'CONFLICT', 'This order expired unpaid. Buying the plan is a new order.');
  if (order.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'CONFLICT', 'This order is not waiting for payment.');
}

/**
 * Lot J2 (b): the term rule's refusal alone — 409 `ALREADY_ON_PLAN` when the
 * order could not activate — asked by every door **before** the wallet is
 * debited (revenue's own /pay, the payments lane at capture), so a plan
 * that cannot start is never charged for. Answers the term it would apply.
 */
export async function assertSubscriptionOrderActivatable(order: Pick<OrderRow, 'publisherId' | 'tier' | 'months'>, now = new Date()): Promise<Term> {
  return resolveTerm(order.publisherId, order.tier, order.months, now);
}

/** Lot J2 (7): the wallet rail, when the policy has closed it. */
function assertWalletOffered(policy: SubscriptionPolicy): void {
  if (policy.payment.walletAllowed) return;
  throw new ApiError(403, 'PAYMENT_METHOD_NOT_OFFERED', 'Paying from your ADX wallet is not offered for subscriptions. Pay through a gateway instead.', {
    method: 'WALLET',
    gatewaysAllowed: policy.payment.gatewaysAllowed,
  });
}

/**
 * The publisher pays from their own wallet — the twin of the advertiser's
 * package debit: wallet − / `platform:revenue` +, PACKAGE_DEBIT under a
 * PACKAGE_SPEND transaction, keyed on the order so a double tap is one
 * movement. Refused 402 when the **withdrawable** balance is short —
 * money still inside its clearing window, held, or reserved for a
 * withdrawal cannot buy a plan — and again inside the movement's own
 * transaction (`requireFunds`), so two concurrent debits cannot both see
 * the same money.
 */
export async function paySubscriptionOrderFromWallet(orderId: string, actor: OrderActor, now = new Date()): Promise<OrderView> {
  const order = await repository.findOrder(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Subscription order not found');
  assertMayPaySubscriptionOrder(order, actor);
  if (order.status === 'PAID') return orderView(order);
  assertSubscriptionOrderPayable(order);
  assertWalletOffered(await publisherPolicy());
  // The term rule before the money: a plan that cannot activate must not be charged for.
  await assertSubscriptionOrderActivatable(order, now);

  const wallet = await ensureWallet({ kind: 'PUBLISHER', id: order.publisherId }, 'Publisher wallet');
  const balance = await snapshot(wallet.id, now);
  const total = new Decimal(order.total);
  if (new Decimal(balance.withdrawable).lessThan(total)) {
    throw new ApiError(402, 'INSUFFICIENT_FUNDS', 'Your withdrawable balance does not cover this plan', {
      required: money(total),
      withdrawable: balance.withdrawable,
    });
  }
  await debitWalletForOrder(wallet.id, order, null, now);

  const paid = await markSubscriptionOrderPaid(order.id, { method: 'WALLET', reference: order.reference }, now);
  return orderView(paid);
}

/** The one debit every wallet door makes — keyed on the order, so it happens once whoever asks. */
async function debitWalletForOrder(walletId: string, order: OrderRow, byUserId: string | null, now: Date): Promise<void> {
  const total = new Decimal(order.total);
  await move({
    walletId,
    walletLabel: 'Publisher wallet',
    amount: money(total.negated()),
    entryType: 'PACKAGE_DEBIT',
    ledgerKind: 'PACKAGE_SPEND',
    idempotencyKey: `subscription-debit:${order.id}`,
    requireFunds: true,
    counterLegs: [{ accountCode: 'platform:revenue', amount: money(total), note: 'Publisher subscription' }],
    reference: order.id,
    note: `${order.planName} plan, ${order.reference}`,
    createdByUserId: byUserId,
    occurredAt: now,
  });
}

/**
 * The activation. Idempotent: a second call on a PAID order returns it
 * unchanged. One transaction: the order becomes PAID and linked, the
 * `PublisherSubscription` (source SELF_SERVICE, the order's own copies of
 * the rate and the price, `endsAt = startsAt + months`) is created, and a
 * different-tier subscription still running ends now. Lot J2: the term may
 * be handed in (the sweep's renewal, which starts at the ending term's end
 * rather than at "now"); the proration credit, when the term carries one,
 * is posted after the activation as its own idempotent movement.
 */
export async function markSubscriptionOrderPaid(
  orderId: string,
  input: { method: 'WALLET' | 'OFFLINE' | 'GATEWAY' | 'TRIAL'; reference?: string | null; term?: Term | undefined; autoRenew?: boolean | undefined },
  now = new Date(),
): Promise<OrderRow> {
  const order = await repository.findOrder(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Subscription order not found');
  if (order.status === 'PAID') return order;
  assertSubscriptionOrderPayable(order);

  const term = input.term ?? (await resolveTerm(order.publisherId, order.tier, order.months, now));
  const result = await repository.activateOrder({
    orderId: order.id,
    now,
    method: input.method,
    reference: input.reference ?? null,
    startsAt: term.startsAt,
    endsAt: term.endsAt,
    endRunningId: term.replaces?.id ?? null,
    autoRenew: input.autoRenew ?? false,
  });
  if (!result.activated || !result.subscription) return result.order;

  if (term.credit) await postProrationCredit(result.order, term.credit, now);

  await notifyActivated(result.order, result.subscription, term, input.method === 'TRIAL');
  return result.order;
}

/** The publisher is told their plan (or trial) is live — in-app + EMAIL + PUSH, best-effort. */
async function notifyActivated(order: OrderRow, subscription: PublisherSubscription, term: Term, isTrial: boolean): Promise<void> {
  const userId = order.publisher.userId;
  if (!userId) return;
  await notify(
    'SUBSCRIPTION_ACTIVATED',
    userId,
    {
      planName: isTrial ? `${order.planName} (free trial)` : order.planName,
      startsAt: dateLabel(subscription.startsAt),
      endsAt: dateLabel(subscription.endsAt ?? term.endsAt),
      reference: order.reference,
    },
    {
      inApp: {
        type: 'SYSTEM',
        title: isTrial ? TRIAL_TITLE : ACTIVATED_TITLE,
        message: isTrial
          ? `Your free trial of ${order.planName} runs until ${dateLabel(subscription.endsAt ?? term.endsAt)}. Buy the plan in the app before then to keep it.`
          : term.rule === 'QUEUED_AFTER_CURRENT'
            ? `${order.planName} is paid for and starts on ${dateLabel(subscription.startsAt)}, when your current term ends. Reference ${order.reference}.`
            : term.credit
              ? `${order.planName} is live until ${dateLabel(subscription.endsAt ?? term.endsAt)}. ₹${term.credit.amount} for the unused days of ${term.credit.planName} is back in your wallet. Reference ${order.reference}.`
              : `${order.planName} is live until ${dateLabel(subscription.endsAt ?? term.endsAt)}. Reference ${order.reference}.`,
        relatedId: subscription.id,
      },
    },
  ).catch(() => undefined);
}

/**
 * Lot J2: the unused days of the replaced term come back as a wallet CREDIT
 * — an ADJUSTMENT line on the publisher wallet against `platform:revenue`
 * (revenue given back), keyed on the order so a retry posts it once, with
 * the reason on the line. Best-effort after the activation it belongs to:
 * a credit that failed to post is logged for finance, never a reason to
 * undo a plan that is already live.
 */
async function postProrationCredit(order: OrderRow, credit: ProrationCredit, now: Date): Promise<void> {
  try {
    const wallet = await ensureWallet({ kind: 'PUBLISHER', id: order.publisherId }, 'Publisher wallet');
    await move({
      walletId: wallet.id,
      walletLabel: 'Publisher wallet',
      amount: credit.amount,
      entryType: 'ADJUSTMENT',
      ledgerKind: 'ADJUSTMENT',
      idempotencyKey: `subscription-proration:${order.id}`,
      counterLegs: [{ accountCode: 'platform:revenue', amount: money(new Decimal(credit.amount).negated()), note: `Unused days of ${credit.planName}` }],
      reference: credit.subscriptionId,
      note: `Unused days of ${credit.planName}`,
      createdByUserId: null,
      occurredAt: now,
    });
  } catch (err) {
    logger.error('Subscription proration credit not posted', { orderId: order.id, subscriptionId: credit.subscriptionId, amount: credit.amount, reason: String(err) });
  }
}

/** The owner or an ADMIN, PENDING_PAYMENT only. An admin's cancel is audited. */
export async function cancelSubscriptionOrder(orderId: string, actor: OrderActor, now = new Date(), req?: Request): Promise<OrderView> {
  const order = await getSubscriptionOrder(orderId, actor);
  if (order.status === 'CANCELLED') return orderView(order);
  if (order.status !== 'PENDING_PAYMENT') {
    throw new ApiError(409, 'CONFLICT', 'Only an order awaiting payment can be cancelled.');
  }
  const cancelled = await repository.cancelOrder(order.id, now);
  if (actor.isAdmin) {
    await logActivity(actor.userId, 'SUBSCRIPTION_ORDER_CANCELLED', {
      req,
      module: 'revenue',
      targetType: 'PublisherSubscriptionOrder',
      targetId: order.id,
      diff: auditDiff({ status: order.status }, { status: cancelled.status }),
      metadata: { reference: order.reference, publisherId: order.publisherId },
    });
  }
  return orderView(cancelled);
}

/** Money that arrived outside ADX — ADMIN, audited. */
export async function recordSubscriptionOrderPayment(
  orderId: string,
  input: { reference: string; method: string },
  editor: Editor,
  now = new Date(),
): Promise<OrderView> {
  const before = await repository.findOrder(orderId);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Subscription order not found');
  if (before.status !== 'PAID') assertSubscriptionOrderPayable(before);
  const paid = await markSubscriptionOrderPaid(orderId, { method: 'OFFLINE', reference: `${input.method}:${input.reference}` }, now);
  await logActivity(editor.userId, 'SUBSCRIPTION_ORDER_RECORDED', {
    req: editor.req,
    module: 'revenue',
    targetType: 'PublisherSubscriptionOrder',
    targetId: paid.id,
    diff: auditDiff(
      { status: before.status, paidReference: before.paidReference, subscriptionId: before.subscriptionId },
      { status: paid.status, paidReference: paid.paidReference, subscriptionId: paid.subscriptionId },
    ),
    metadata: { reference: paid.reference, method: input.method, paymentReference: input.reference, total: money(paid.total) },
  });
  return orderView(paid);
}

export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'] as const;

export async function listSubscriptionOrdersPage(query: {
  status?: readonly OrderRow['status'][] | undefined;
  publisherId?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}) {
  const { items, total, counts } = await repository.listOrdersPage(query);
  return toListPage(items.map(orderView), total, counts, query);
}

/* ------------------------------------------------------------------ */
/* Lot J2 (5): free trials                                             */
/* ------------------------------------------------------------------ */

/** The tiers this publisher may still start a trial of, with the days — empty once they have ever held anything. */
export function trialTiersAvailable(policy: SubscriptionPolicy, history: readonly { id: string }[], catalogue: readonly { tier: string; isActive: boolean }[]): Record<string, number> {
  if (history.length > 0) return {};
  const out: Record<string, number> = {};
  for (const plan of catalogue) {
    const days = policy.trialDays[plan.tier] ?? 0;
    if (plan.isActive && days > 0) out[plan.tier] = days;
  }
  return out;
}

const trialAlreadyUsed = () => new ApiError(409, 'TRIAL_ALREADY_USED', 'A free trial is for a first subscription; you have held a plan before. Buy the plan instead.');

/**
 * A first-ever subscriber starts a free trial of a tier: an order PAID at
 * once with a zero total and `paidMethod` TRIAL, and a subscription of
 * `trialDays` (source SELF_SERVICE). Refused 409 when the tier offers no
 * trial, and when the publisher has ever held any subscription or trial —
 * granted or bought, running or not — because a trial is for a first
 * subscription and a second trial is a discount nobody approved.
 *
 * Lot K (B2): the "never held anything" check is asked twice — once here,
 * for the plain refusal, and again inside the repository's transaction
 * under a per-publisher advisory lock (`pg_advisory_xact_lock`, the way
 * `wallets.move` serialises a wallet), so two taps arriving together are
 * one trial and one 409, never two trials.
 */
export async function startSubscriptionTrial(input: { publisherId: string; userId: string; tier: Tier; now?: Date }): Promise<{ order: OrderView; subscription: SubscriptionView }> {
  const now = input.now ?? new Date();
  const policy = await publisherPolicy();
  const days = policy.trialDays[input.tier] ?? 0;
  if (days <= 0) throw new ApiError(409, 'TRIAL_NOT_OFFERED', `The ${titleCase(input.tier)} plan does not offer a free trial.`);
  const history = await repository.listSubscriptionsForPublisher(input.publisherId);
  if (history.length > 0) throw trialAlreadyUsed();
  const plan = await activePlanOrThrow(input.tier);
  const zero = new Decimal(0);
  const endsAt = new Date(now.getTime() + days * DAY_MS);
  const started = await repository.startTrial({
    publisherId: input.publisherId,
    now,
    startsAt: now,
    endsAt,
    order: {
      reference: await nextReference(now),
      publisherId: input.publisherId,
      createdByUserId: input.userId,
      tier: plan.tier,
      planName: plan.name,
      pricePerMonth: new Decimal(plan.pricePerMonth),
      ratePct: new Decimal(plan.ratePct),
      cycle: 'MONTHLY',
      // The term is `days`, not months; nothing was billed.
      months: 0,
      subtotal: zero,
      discountPct: zero,
      discountAmount: zero,
      gstPct: zero,
      gstAmount: zero,
      total: zero,
      startsAt: now,
    },
  });
  // The re-check under the lock: another start got there first.
  if (!started.started) throw trialAlreadyUsed();
  const term: Term = { rule: 'STARTS_NOW', startsAt: now, endsAt, replaces: null, credit: null };
  await notifyActivated(started.order, started.subscription, term, true);
  return { order: orderView(started.order), subscription: subscriptionView(started.subscription, await publisherPlansByTier()) };
}

/* ------------------------------------------------------------------ */
/* Lot J2 (6): the subscriber's auto-renew switch                      */
/* ------------------------------------------------------------------ */

/** `PATCH /revenue/subscriptions/me { autoRenew }`: the flag on the running row; 409 while the policy does not offer it. */
export async function setMySubscriptionAutoRenew(publisherId: string, autoRenew: boolean, now = new Date()): Promise<SubscriptionView> {
  const policy = await publisherPolicy();
  if (autoRenew && !policy.autoRenew.allowed) {
    throw new ApiError(409, 'AUTO_RENEW_NOT_OFFERED', 'Auto-renew is not offered');
  }
  const running = await revenueRepository.findRunningSubscription(publisherId, now);
  if (!running) throw new ApiError(404, 'NOT_FOUND', 'You have no running subscription to renew.');
  // Lot K (B2): a trial is not a term that renews — the plan is bought, not extended.
  if (autoRenew && isTrialOrder(await repository.findOrderBySubscription(running.id))) {
    throw new ApiError(409, 'AUTO_RENEW_NOT_OFFERED', 'A trial does not renew - buy the plan');
  }
  const updated = running.autoRenew === autoRenew ? running : await repository.setSubscriptionAutoRenew(running.id, autoRenew);
  return subscriptionView(updated, await publisherPlansByTier());
}

/* ------------------------------------------------------------------ */
/* Lot J2 (4): grace — the entitled reads                              */
/* ------------------------------------------------------------------ */

export type EntitledSubscription = {
  id: string;
  tier: Tier;
  startsAt: Date;
  endsAt: Date | null;
  /** True when the term has ended and the policy's grace window still covers it. */
  inGrace: boolean;
  /** `endsAt + graceDays`; null for an open-ended term. */
  graceEndsAt: Date | null;
};

const graceEnd = (endsAt: Date | null, graceDays: number): Date | null => (endsAt ? new Date(endsAt.getTime() + graceDays * DAY_MS) : null);

const entitledRow = (row: PublisherSubscription, at: Date, graceDays: number): EntitledSubscription => {
  const running = row.startsAt <= at && (row.endsAt === null || row.endsAt > at);
  return { id: row.id, tier: row.tier, startsAt: row.startsAt, endsAt: row.endsAt, inGrace: !running, graceEndsAt: graceEnd(row.endsAt, graceDays) };
};

/**
 * The subscription a publisher is entitled under at `at`: the running one,
 * or — with `graceDays` on the policy — the one that ended within that
 * many days, marked `inGrace`. What `support`'s live-chat door reads. The
 * commission resolution keeps reading the running row through
 * `runningSubscriptionForPublisher`: a rate is what was paid for, and a
 * grace day is a courtesy on the copy, never on the take.
 */
export async function entitledSubscriptionForPublisher(publisherId: string, at: Date = new Date()): Promise<EntitledSubscription | null> {
  const { graceDays } = await publisherPolicy();
  const running = await revenueRepository.findRunningSubscription(publisherId, at);
  if (running) return entitledRow(running, at, graceDays);
  if (graceDays <= 0) return null;
  const lapsed = await revenueRepository.findLapsedSubscription(publisherId, new Date(at.getTime() - graceDays * DAY_MS), at);
  return lapsed ? entitledRow(lapsed, at, graceDays) : null;
}

/** The same fact for a set of publishers — two queries, the running rows then the lapsed ones for whoever has nothing running. */
export async function entitledSubscriptionsForPublishers(publisherIds: readonly string[], at: Date = new Date()): Promise<Map<string, EntitledSubscription>> {
  const out = new Map<string, EntitledSubscription>();
  const unique = [...new Set(publisherIds)];
  if (unique.length === 0) return out;
  const { graceDays } = await publisherPolicy();
  for (const row of await revenueRepository.findRunningSubscriptions(unique, at)) {
    if (!out.has(row.publisherId)) out.set(row.publisherId, entitledRow(row, at, graceDays));
  }
  const missing = unique.filter((id) => !out.has(id));
  if (graceDays <= 0 || missing.length === 0) return out;
  for (const row of await revenueRepository.findLapsedSubscriptions(missing, new Date(at.getTime() - graceDays * DAY_MS), at)) {
    if (!out.has(row.publisherId)) out.set(row.publisherId, entitledRow(row, at, graceDays));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The phone's screen, and the console's list                          */
/* ------------------------------------------------------------------ */

export type SubscriptionView = {
  id: string;
  tier: Tier;
  planName: string;
  ratePct: string;
  pricePerMonth: Money;
  startsAt: Date;
  endsAt: Date | null;
  source: PublisherSubscription['source'];
  /** Lot J2: the subscriber's own switch; honoured only while the policy allows it. */
  autoRenew: boolean;
};

const subscriptionView = (row: PublisherSubscription, plans: Map<Tier, PlanByTier>): SubscriptionView => ({
  id: row.id,
  tier: row.tier,
  planName: plans.get(row.tier)?.name ?? titleCase(row.tier),
  ratePct: new Decimal(row.ratePct).toFixed(4),
  pricePerMonth: money(row.pricePerMonth),
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  source: row.source,
  autoRenew: row.autoRenew,
});

export type PurchaseOption = {
  tier: Tier;
  allowed: boolean;
  /** Why not, when `allowed` is false; the term rule that would apply when it is. */
  reason: 'ALREADY_ON_PLAN' | null;
  rule: TermRule | null;
  startsAt: Date | null;
};

/**
 * What the publisher's subscription screen reads: the running term, what is
 * queued after it, the running tier's plan, every order newest first, and
 * whether — and which plan — they can buy. Lot J2: the policy the phone
 * prints, the trials still open to them, and the change rule per tier.
 */
export async function mySubscription(publisherId: string, now = new Date()) {
  const [plans, policy, running, all, orders] = await Promise.all([
    publisherPlansByTier(),
    publisherPolicy(),
    revenueRepository.findRunningSubscription(publisherId, now),
    repository.listSubscriptionsForPublisher(publisherId),
    repository.listOrdersForPublisher(publisherId),
  ]);
  const upcoming = all
    .filter((row) => row.startsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((row) => subscriptionView(row, plans));

  const catalogue = (await repository.listPlans(false)).map(planView);
  const options: PurchaseOption[] = catalogue.map((plan) => {
    if (running && running.tier === plan.tier && running.endsAt === null) {
      return { tier: plan.tier, allowed: false, reason: 'ALREADY_ON_PLAN', rule: null, startsAt: null };
    }
    if (!running) return { tier: plan.tier, allowed: true, reason: null, rule: 'STARTS_NOW', startsAt: now };
    if (running.tier === plan.tier) {
      return { tier: plan.tier, allowed: true, reason: null, rule: 'QUEUED_AFTER_CURRENT', startsAt: running.endsAt };
    }
    if (policy.changePolicy === 'QUEUE_AFTER_TERM') {
      return running.endsAt === null
        ? { tier: plan.tier, allowed: false, reason: 'ALREADY_ON_PLAN', rule: null, startsAt: null }
        : { tier: plan.tier, allowed: true, reason: null, rule: 'QUEUED_AFTER_CURRENT', startsAt: running.endsAt };
    }
    return { tier: plan.tier, allowed: true, reason: null, rule: 'REPLACES_CURRENT', startsAt: now };
  });
  const canBuy = options.some((option) => option.allowed);

  const runningPlan = running ? (await repository.findPlan(running.tier)) : null;
  // Lot K (B2): with nothing running, the term the policy's grace window still covers, if any.
  const lapsed = !running && policy.graceDays > 0 ? await revenueRepository.findLapsedSubscription(publisherId, new Date(now.getTime() - policy.graceDays * DAY_MS), now) : null;
  const grace: SubscriptionGrace | null = lapsed?.endsAt
    ? { tier: lapsed.tier, planName: plans.get(lapsed.tier)?.name ?? titleCase(lapsed.tier), endsAt: lapsed.endsAt, until: new Date(lapsed.endsAt.getTime() + policy.graceDays * DAY_MS) }
    : null;
  return {
    running: running ? subscriptionView(running, plans) : null,
    /** Lot K (B2): the ended term still honoured under grace — null while one runs, or once the window has passed. */
    grace,
    upcoming,
    plan: runningPlan ? planView(runningPlan) : null,
    orders: orders.map(orderView),
    catalogue,
    options,
    canBuy,
    reason: canBuy ? null : catalogue.length === 0 ? 'NO_PLANS_ON_SALE' : 'ALREADY_ON_PLAN',
    /** Lot J2: the tiers this publisher may still start a free trial of, with the days. */
    trialAvailable: trialTiersAvailable(policy, all, catalogue),
    policy: policyView(policy, running?.tier ?? catalogue[0]?.tier ?? 'STANDARD'),
  };
}

/** Lot K (B2): what the phone prints while an ended term is still honoured. */
export type SubscriptionGrace = { tier: Tier; planName: string; endsAt: Date; until: Date };

export type SubscriptionListItem = SubscriptionView & {
  publisher: { id: string; name: string; displayId: string | null };
  state: 'RUNNING' | 'UPCOMING' | 'ENDED';
  /** Lot K (B2): ENDED, and the policy's grace window still covers it. */
  inGrace: boolean;
  /** `endsAt + graceDays`; null for an open-ended term. */
  graceEndsAt: Date | null;
  createdAt: Date;
};

/** Lot J2 (d): `GET /revenue/subscriptions` on the list contract — a page, its total and a count per state. */
export async function listSubscriptionsPage(query: SubscriptionListFilter, now = new Date()) {
  const [plans, policy, { items, total, counts }] = await Promise.all([publisherPlansByTier(), publisherPolicy(), repository.listSubscriptionsPage(query, now)]);
  const state = (row: PublisherSubscription): SubscriptionListItem['state'] =>
    row.startsAt > now ? 'UPCOMING' : row.endsAt !== null && row.endsAt <= now ? 'ENDED' : 'RUNNING';
  const rows: SubscriptionListItem[] = items.map((row) => {
    const graceEndsAt = graceEnd(row.endsAt, policy.graceDays);
    const rowState = state(row);
    return {
      ...subscriptionView(row, plans),
      publisher: { id: row.publisher.id, name: row.publisher.name, displayId: row.publisher.displayId },
      state: rowState,
      inGrace: rowState === 'ENDED' && policy.graceDays > 0 && graceEndsAt !== null && graceEndsAt > now,
      graceEndsAt,
      createdAt: row.createdAt,
    };
  });
  return toListPage(rows, total, counts, query);
}

/* ------------------------------------------------------------------ */
/* The daily sweep                                                     */
/* ------------------------------------------------------------------ */

export const ACTIVATED_TITLE = 'Subscription activated';
export const TRIAL_TITLE = 'Your free trial has started';
export const EXPIRING_TITLE = 'Your subscription ends soon';
export const ENDED_TITLE = 'Your subscription has ended';
export const RENEWED_TITLE = 'Your subscription has renewed';
export const RENEWAL_FAILED_TITLE = 'Your subscription could not renew';

/** The plain reminder line, when nothing renews on its own. */
const RENEW_IN_APP = 'Renew in the ADX app before then to keep your rate; a renewal starts the day the current term ends.';
/** Lot K (B2): the trial's line — a trial does not renew, it is bought. */
const TRIAL_ENDS = 'Buy the plan in the ADX app before then to keep your rate; a trial does not renew.';

export type SweepSummary = { expiringNotified: number; endedNotified: number; ordersExpired: number; renewed: number; renewalsFailed: number };

/**
 * Four duties, once a day (`jobs/publisher-subscription.job.ts`), every
 * window from the publisher policy (Lot J2):
 *
 *  1. every subscription ending within `reminderLeadDays` gets the expiring
 *     notice once — the marker is the in-app row the notice writes, keyed
 *     on the subscription id and the title, so a re-run sends nothing
 *     twice; with auto-renew on (theirs and the policy's) the line says
 *     what the wallet will be charged and when;
 *  2. every subscription that lapsed inside that window with auto-renew on
 *     — while the policy allows it — is renewed: the next order on the
 *     same tier and cycle, paid from the wallet through the same
 *     idempotent debit and activation (`SUBSCRIPTION_RENEWED`), or, with
 *     the wallet short, `SUBSCRIPTION_RENEWAL_FAILED` once with the
 *     shortfall, the flag left on and the row lapsing into grace like any
 *     other. The queued order's existence is what makes it never charge
 *     twice; with the policy's switch off nobody is charged;
 *  3. every subscription that lapsed gets the ended notice once, unless
 *     another term of theirs is in force at the moment it ended (a queued
 *     renewal, a replacement, the renewal above) — nothing ended for them;
 *  4. every PENDING_PAYMENT order older than `unpaidOrderExpiryDays`
 *     becomes EXPIRED.
 */
export async function runPublisherSubscriptionSweep(now = new Date()): Promise<SweepSummary> {
  const [plans, policy] = await Promise.all([publisherPlansByTier(), publisherPolicy()]);
  const rates = await subscriptionRates(policy);
  const lead = policy.reminderLeadDays;
  const autoRenewOn = policy.autoRenew.allowed;
  let expiringNotified = 0;
  let endedNotified = 0;
  let renewed = 0;
  let renewalsFailed = 0;

  const expiring = await repository.findEndingBetween(now, new Date(now.getTime() + lead * DAY_MS));
  for (const row of expiring) {
    const userId = row.publisher.userId;
    if (!userId || !row.endsAt) continue;
    if (await repository.noticeSent(userId, row.id, EXPIRING_TITLE)) continue;
    const planName = plans.get(row.tier)?.name ?? titleCase(row.tier);
    const days = Math.max(1, Math.ceil((row.endsAt.getTime() - now.getTime()) / DAY_MS));
    // Lot K (B2): a trial never renews, whatever its flag says.
    const trial = isTrialOrder(row.order);
    const willRenew = autoRenewOn && row.autoRenew && !trial;
    const total = willRenew ? (await renewalPrice(row, rates)).total : null;
    const renewal = willRenew && total ? `It renews from your wallet on ${dateLabel(row.endsAt)} for ₹${total}.` : trial ? TRIAL_ENDS : RENEW_IN_APP;
    await notify(
      'SUBSCRIPTION_EXPIRING',
      userId,
      { planName, endsAt: dateLabel(row.endsAt), days: String(days), renewal },
      {
        inApp: {
          type: 'SYSTEM',
          title: EXPIRING_TITLE,
          message: willRenew && total
            ? `Your ${planName} plan renews from your wallet on ${dateLabel(row.endsAt)} for ₹${total}.`
            : trial
              ? `Your free trial of ${planName} ends on ${dateLabel(row.endsAt)}. Buy the plan in the app to keep your rate.`
              : `Your ${planName} plan ends on ${dateLabel(row.endsAt)}. Renew in the app to keep your rate.`,
          relatedId: row.id,
        },
      },
      now,
    );
    expiringNotified += 1;
  }

  const ended = await repository.findEndingBetween(new Date(now.getTime() - lead * DAY_MS), now);
  // The rows renewed on this run: their successor now exists, so no ended notice.
  const renewedIds = new Set<string>();
  if (autoRenewOn) {
    for (const row of ended) {
      // Lot K (B2): a TRIAL row never renews — the plan is bought, not extended.
      if (!row.autoRenew || !row.endsAt || isTrialOrder(row.order)) continue;
      if (await repository.hasSuccessor(row.publisherId, row.endsAt, row.id)) continue;
      const outcome = await renewSubscription(row, plans, policy, rates, now);
      if (outcome === 'RENEWED') {
        renewed += 1;
        renewedIds.add(row.id);
      } else if (outcome === 'FAILED') renewalsFailed += 1;
    }
  }

  for (const row of ended) {
    const userId = row.publisher.userId;
    if (!userId || !row.endsAt || renewedIds.has(row.id)) continue;
    if (await repository.noticeSent(userId, row.id, ENDED_TITLE)) continue;
    if (await repository.hasSuccessor(row.publisherId, row.endsAt, row.id)) continue;
    const planName = plans.get(row.tier)?.name ?? titleCase(row.tier);
    await notify(
      'SUBSCRIPTION_ENDED',
      userId,
      { planName, endedAt: dateLabel(row.endsAt) },
      {
        inApp: {
          type: 'SYSTEM',
          title: ENDED_TITLE,
          message: `Your ${planName} plan ended on ${dateLabel(row.endsAt)}. Bookings now carry the standard rate; buy a plan in the app to lower it.`,
          relatedId: row.id,
        },
      },
      now,
    );
    endedNotified += 1;
  }

  const ordersExpired = await repository.expireStaleOrders(new Date(now.getTime() - policy.unpaidOrderExpiryDays * DAY_MS));
  return { expiringNotified, endedNotified, ordersExpired, renewed, renewalsFailed };
}

type EndingRow = Awaited<ReturnType<typeof repository.findEndingBetween>>[number];

/** The cycle a renewal is bought on: the one the term was bought on, while the policy still offers it; the first offered otherwise. */
function renewalCycle(row: EndingRow, policy: SubscriptionPolicy): Cycle {
  const bought = row.order?.cycle ?? 'MONTHLY';
  return policy.cyclesOffered.includes(bought) ? bought : policy.cyclesOffered[0]!;
}

/** What the next term costs: the catalogue's price today (an edit changes the next order, never the running one), on the renewal cycle. */
async function renewalPrice(row: EndingRow, rates: PricingRates, policy?: SubscriptionPolicy): Promise<PricedSubscription & { plan: PlanRow | null }> {
  const rules = policy ?? (await publisherPolicy());
  const plan = await repository.findPlan(row.tier);
  const pricePerMonth = money(plan?.pricePerMonth ?? row.pricePerMonth);
  return { ...priceSubscription({ pricePerMonth, cycle: renewalCycle(row, rules), rates }), plan };
}

/**
 * One renewal: the queued order (found, or minted) for the tier and cycle,
 * starting the moment the old term ended; the wallet asked for the total;
 * the same debit and activation every wallet door makes, the flag carried
 * onto the new term; and the publisher told. A short wallet is told once.
 */
async function renewSubscription(row: EndingRow, plans: Map<Tier, PlanByTier>, policy: SubscriptionPolicy, rates: PricingRates, now: Date): Promise<'RENEWED' | 'FAILED' | 'SKIPPED'> {
  const userId = row.publisher.userId;
  const endsAt = row.endsAt!;
  const planName = plans.get(row.tier)?.name ?? titleCase(row.tier);
  const priced = await renewalPrice(row, rates, policy);

  const fail = async (reason: string, shortfall: Money): Promise<'FAILED'> => {
    if (userId && !(await repository.noticeSent(userId, row.id, RENEWAL_FAILED_TITLE))) {
      await notify(
        'SUBSCRIPTION_RENEWAL_FAILED',
        userId,
        { planName, total: priced.total, shortfall, reason, endedAt: dateLabel(endsAt) },
        {
          inApp: {
            type: 'SYSTEM',
            title: RENEWAL_FAILED_TITLE,
            message: `Your ${planName} plan could not renew from your wallet: ${reason} Top up and buy the plan in the app to keep your rate.`,
            relatedId: row.id,
          },
        },
        now,
      );
    }
    return 'FAILED';
  };

  if (!priced.plan || !priced.plan.isActive) return fail('the plan is no longer on sale.', priced.total);

  let order = await repository.findOrderStartingAt(row.publisherId, row.tier, endsAt);
  if (order?.status === 'PAID') return 'SKIPPED';
  if (!order) {
    order = await repository.createOrder({
      reference: await nextReference(now),
      publisherId: row.publisherId,
      createdByUserId: userId ?? row.publisher.id,
      tier: row.tier,
      planName: priced.plan.name,
      pricePerMonth: new Decimal(priced.plan.pricePerMonth),
      ratePct: new Decimal(priced.plan.ratePct),
      cycle: priced.cycle,
      months: priced.months,
      subtotal: new Decimal(priced.subtotal),
      discountPct: new Decimal(priced.discountPct),
      discountAmount: new Decimal(priced.discountAmount),
      gstPct: new Decimal(priced.gstPct),
      gstAmount: new Decimal(priced.gstAmount),
      total: new Decimal(priced.total),
      startsAt: endsAt,
    });
  }

  // Lot K (B2): the keyed debit first. A run that debited and then failed to
  // activate has already paid for this term — activation is what is left,
  // and a balance the debit just emptied must not fail the renewal.
  if (!(await repository.debitPosted(`subscription-debit:${order.id}`))) {
    const wallet = await ensureWallet({ kind: 'PUBLISHER', id: row.publisherId }, 'Publisher wallet');
    const balance = await snapshot(wallet.id, now);
    const total = new Decimal(order.total);
    if (new Decimal(balance.withdrawable).lessThan(total)) {
      return fail(`your withdrawable balance is ₹${balance.withdrawable} and the plan costs ₹${money(total)}.`, money(total.minus(new Decimal(balance.withdrawable))));
    }
    try {
      await debitWalletForOrder(wallet.id, order, null, now);
    } catch (err) {
      return fail(err instanceof Error ? `${err.message}.` : 'the wallet refused the debit.', money(total));
    }
  }
  const term: Term = { rule: 'QUEUED_AFTER_CURRENT', startsAt: endsAt, endsAt: addMonths(endsAt, order.months), replaces: null, credit: null };
  const paid = await markSubscriptionOrderPaid(order.id, { method: 'WALLET', reference: order.reference, term, autoRenew: true }, now);
  if (userId) {
    await notify(
      'SUBSCRIPTION_RENEWED',
      userId,
      { planName, startsAt: dateLabel(term.startsAt), endsAt: dateLabel(term.endsAt), total: money(paid.total), reference: paid.reference },
      {
        inApp: {
          type: 'SYSTEM',
          title: RENEWED_TITLE,
          message: `Your ${planName} plan renewed from your wallet for ₹${money(paid.total)} and runs until ${dateLabel(term.endsAt)}. Reference ${paid.reference}.`,
          relatedId: paid.subscriptionId ?? row.id,
        },
      },
      now,
    );
  }
  return 'RENEWED';
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const titleCase = (value: string): string => value.charAt(0) + value.slice(1).toLowerCase();

/** 14 Sep 2026, as the publisher reads it in India. */
export function dateLabel(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}
