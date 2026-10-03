import { scoreOf } from '../signals';
import type { LinkedParty, StoredSignal } from '../signals';

/**
 * Order fraud screening — the arithmetic (the owner, 2 Oct 2026).
 *
 * Pure: every function here is a function of what it is handed, so the
 * scoring is tested signal by signal without a database. The reads that
 * gather the facts are `order-screening.service.ts` over
 * `prisma-order-screening.repository.ts`.
 *
 * An order's score is the party score's rule applied to three sides at once:
 * `min(1, Σ weight × value)` over the advertiser's party signals, the
 * publisher's party signals and the order's own six. Every signal carries
 * its side, so the desk reads which party (or the order itself) said what.
 * The score is explainable, and it is never acted on alone: it flags for a
 * person; with automatic holds on (off by default — watch mode) it may also
 * HOLD, which is reversible. Cancelling and suspending are a person's.
 */

export type SignalSide = 'ADVERTISER' | 'PUBLISHER' | 'ORDER';

/** One signal on an order: the party signal's row (candidates dropped), with its side. */
export type OrderSignalRow = {
  key: string;
  weight: number;
  value: number | null;
  detail: string;
  side: SignalSide;
  links?: LinkedParty[];
};

export type OrderRiskBandValue = 'LOW' | 'REVIEW' | 'HOLD';
export type OrderRiskReviewValue = 'FLAGGED' | 'CLEARED' | 'CONFIRMED_FRAUD';

/** The settings the order signals and the bands read — `fraud.orderScreening`. */
export type ScreeningSettings = {
  enabled: boolean;
  reviewThreshold: number;
  holdThreshold: number;
  autoHold: boolean;
  newAccountDays: number;
  bigOrderAmount: number;
  velocityCount: number;
  velocityMinutes: number;
};

/** The six order signals and what each can add when fully present. */
export const ORDER_SIGNAL_WEIGHTS = {
  NEW_ACCOUNT_BIG_ORDER: 0.35,
  ORDER_VELOCITY: 0.25,
  DUPLICATE_ORDER: 0.3,
  PAYMENT_TROUBLE: 0.25,
  LINKED_PARTIES: 0.5,
  PRIOR_CONFIRMED_FRAUD: 0.6,
} as const;
export type OrderSignalKey = keyof typeof ORDER_SIGNAL_WEIGHTS;
export const ORDER_SIGNAL_KEYS = Object.keys(ORDER_SIGNAL_WEIGHTS) as OrderSignalKey[];

/** What the order signals read — gathered by the service, handed here. */
export type OrderFacts = {
  /** The order's value (`Order.budget`), rupees; null when it carries none. */
  value: number | null;
  placedAt: Date;
  /** When the advertiser account began (the profile's `createdAt`, else the login's); null when unknown. */
  advertiserSince: Date | null;
  /** Orders the same login placed in the velocity window ending at `placedAt`, this one included. */
  recentOrderCount: number;
  /** Other live orders by the same login on the same spot whose flights overlap this one's. */
  duplicates: { id: string; displayId: string | null }[];
  /** What the payments module records; null when there is nothing to read (no advertiser profile). */
  payments: { failedAttempts: number; refunds: number } | null;
  /** Why the advertiser and the publisher look like the same people — plain words, one per tie. */
  links: string[];
  /** CONFIRMED fraud cases on either party, and CONFIRMED_FRAUD orders by either, this order excluded. */
  priorFraud: { advertiserCases: number; publisherCases: number; advertiserOrders: number; publisherOrders: number };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const rupees = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const row = (key: OrderSignalKey, value: number | null, detail: string): OrderSignalRow => ({
  key,
  weight: ORDER_SIGNAL_WEIGHTS[key],
  value: value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000,
  detail,
  side: 'ORDER',
});

/** New account, large order: younger than `newAccountDays` and worth more than `bigOrderAmount`. */
export function newAccountBigOrder(facts: OrderFacts, settings: ScreeningSettings): OrderSignalRow {
  if (facts.value === null) return row('NEW_ACCOUNT_BIG_ORDER', 0, 'The order carries no value to compare.');
  if (!facts.advertiserSince) return row('NEW_ACCOUNT_BIG_ORDER', 0, 'The account’s age is not known.');
  const ageDays = Math.max(0, Math.floor((facts.placedAt.getTime() - facts.advertiserSince.getTime()) / DAY_MS));
  const young = ageDays < settings.newAccountDays;
  const big = facts.value > settings.bigOrderAmount;
  const hit = young && big;
  return row(
    'NEW_ACCOUNT_BIG_ORDER',
    hit ? 1 : 0,
    `An account ${plural(ageDays, 'day')} old placed ${rupees(facts.value)}` +
      (hit ? ` — younger than ${settings.newAccountDays} days and over ${rupees(settings.bigOrderAmount)}.` : '.'),
  );
}

/** Many orders in a short time: more than `velocityCount` by one advertiser in `velocityMinutes`. */
export function orderVelocity(facts: OrderFacts, settings: ScreeningSettings): OrderSignalRow {
  const hit = facts.recentOrderCount > settings.velocityCount;
  return row(
    'ORDER_VELOCITY',
    hit ? 1 : 0,
    `${plural(facts.recentOrderCount, 'order')} by this advertiser in ${settings.velocityMinutes} minutes` +
      (hit ? ` — more than ${settings.velocityCount}.` : '.'),
  );
}

/** The same spot and dates ordered twice by the same advertiser. */
export function duplicateOrder(facts: OrderFacts): OrderSignalRow {
  const n = facts.duplicates.length;
  if (n === 0) return row('DUPLICATE_ORDER', 0, 'No other order by this advertiser on this spot for overlapping dates.');
  const names = facts.duplicates.slice(0, 3).map((d) => d.displayId ?? d.id).join(', ');
  return row('DUPLICATE_ORDER', 1, `Also ordered this spot for overlapping dates: ${names}${n > 3 ? ` and ${n - 3} more` : ''}.`);
}

/** Payment trouble: failed attempts before the one that went through, and refunds lately. */
export function paymentTrouble(facts: OrderFacts): OrderSignalRow {
  if (!facts.payments) return row('PAYMENT_TROUBLE', 0, 'No payment records to read for this advertiser.');
  const { failedAttempts, refunds } = facts.payments;
  const value = Math.max(Math.min(1, failedAttempts / 3), Math.min(1, refunds / 2));
  if (value === 0) return row('PAYMENT_TROUBLE', 0, 'No failed payments and no refunds lately.');
  const parts = [failedAttempts > 0 ? `${plural(failedAttempts, 'failed payment attempt')}` : null, refunds > 0 ? `${plural(refunds, 'refund')} in 90 days` : null].filter(Boolean);
  return row('PAYMENT_TROUBLE', value, `${parts.join(' and ')}.`);
}

/** The advertiser and the publisher look like the same people. */
export function linkedParties(facts: OrderFacts): OrderSignalRow {
  if (facts.links.length === 0) return row('LINKED_PARTIES', 0, 'Nothing ties the advertiser to the publisher.');
  return row('LINKED_PARTIES', 1, `The advertiser and the publisher share: ${facts.links.join('; ')}.`);
}

/** Either party was confirmed as fraud before. */
export function priorConfirmedFraud(facts: OrderFacts): OrderSignalRow {
  const p = facts.priorFraud;
  const parts = [
    p.advertiserCases ? `the advertiser has ${plural(p.advertiserCases, 'confirmed fraud case')}` : null,
    p.publisherCases ? `the publisher has ${plural(p.publisherCases, 'confirmed fraud case')}` : null,
    p.advertiserOrders ? `the advertiser has ${plural(p.advertiserOrders, 'order')} confirmed as fraud` : null,
    p.publisherOrders ? `the publisher’s spots have ${plural(p.publisherOrders, 'order')} confirmed as fraud` : null,
  ].filter(Boolean);
  if (parts.length === 0) return row('PRIOR_CONFIRMED_FRAUD', 0, 'Neither party has been confirmed as fraud before.');
  const text = parts.join('; ');
  return row('PRIOR_CONFIRMED_FRAUD', 1, `${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
}

/** The six, in the order the desk prints them. */
export function orderSignals(facts: OrderFacts, settings: ScreeningSettings): OrderSignalRow[] {
  return [
    newAccountBigOrder(facts, settings),
    orderVelocity(facts, settings),
    duplicateOrder(facts),
    paymentTrouble(facts),
    linkedParties(facts),
    priorConfirmedFraud(facts),
  ];
}

/** A party's stored signals as order rows — the side stamped, the compared-against candidates dropped (the case keeps those). */
export function partyRows(signals: readonly StoredSignal[], side: 'ADVERTISER' | 'PUBLISHER'): OrderSignalRow[] {
  return signals.map((signal) => ({
    key: signal.key,
    weight: signal.weight,
    value: signal.value,
    detail: signal.detail,
    side,
    ...(signal.links?.length ? { links: signal.links } : {}),
  }));
}

/** Plain words for a shared signal that ties the two parties. */
const LINK_WORDS: Record<string, string> = {
  SHARED_PAN: 'the same PAN',
  SHARED_BANK: 'the same bank account or UPI id',
  SHARED_IP_SUBNET: 'the same internet connection (sign-in subnet)',
  SHARED_PHONE_ACROSS_ROLES: 'the same phone number',
  SHARED_DEVICE: 'the same device',
  SELF_DEALING: 'the same PAN or bank account (self-dealing)',
};

/**
 * Why the advertiser and the publisher look linked: a shared signal on
 * either side whose links name the other party, the same login on both, or
 * the same agent having onboarded both. Distinct, in that order.
 */
export function linksBetween(input: {
  advertiserSignals: readonly StoredSignal[];
  publisherSignals: readonly StoredSignal[];
  advertiser: { id: string; userId: string | null; agentId: string | null; onboardedByAgentUserId: string | null } | null;
  publisher: { id: string; userId: string | null; agentId: string | null; onboardedByAgentUserId: string | null } | null;
}): string[] {
  const { advertiser, publisher } = input;
  if (!advertiser || !publisher) return [];
  const out: string[] = [];
  const add = (words: string) => {
    if (!out.includes(words)) out.push(words);
  };
  for (const signal of input.advertiserSignals) {
    if (signal.links?.some((party) => party.type === 'PUBLISHER' && party.id === publisher.id)) add(LINK_WORDS[signal.key] ?? signal.key);
  }
  for (const signal of input.publisherSignals) {
    if (signal.links?.some((party) => party.type === 'ADVERTISER' && party.id === advertiser.id)) add(LINK_WORDS[signal.key] ?? signal.key);
  }
  if (advertiser.userId && advertiser.userId === publisher.userId) add('the same login placed the order and owns the spot');
  const sameAgent =
    (advertiser.agentId && advertiser.agentId === publisher.agentId) ||
    (advertiser.onboardedByAgentUserId && advertiser.onboardedByAgentUserId === publisher.onboardedByAgentUserId);
  if (sameAgent) add('the same agent onboarded both');
  return out;
}

/** `min(1, Σ weight × value)` over every side — the party score's own rule. */
export function combineOrderScore(rows: readonly OrderSignalRow[]): number {
  return scoreOf(rows);
}

/** What the score says, against the thresholds. */
export function bandFor(score: number, settings: Pick<ScreeningSettings, 'reviewThreshold' | 'holdThreshold'>): OrderRiskBandValue {
  if (score >= settings.holdThreshold) return 'HOLD';
  if (score >= settings.reviewThreshold) return 'REVIEW';
  return 'LOW';
}

/** A signal's identity across re-scores — `SIDE:KEY`, since both parties run the same party signals. */
export const signalIdentity = (signal: Pick<OrderSignalRow, 'side' | 'key'>) => `${signal.side}:${signal.key}`;

/** The signals that said something (value above 0), by identity. */
export function firingKeys(rows: readonly OrderSignalRow[]): string[] {
  return rows.filter((r) => r.value !== null && r.value > 0).map(signalIdentity);
}

export type ScreeningOutcome = {
  band: OrderRiskBandValue;
  /** The review status to write (unchanged when nothing moved it). */
  reviewStatus: OrderRiskReviewValue | null;
  /** True when this scoring flagged an order that was not flagged before — the desk is told. */
  newlyFlagged: boolean;
  /** True when this scoring should hold the order: auto-hold on, at the hold threshold, open, not held. */
  hold: boolean;
  /** Firing signals a Clear has not dismissed. */
  newSignals: string[];
};

/**
 * What a scoring does to the review, given where the order stands.
 *
 *  - A CONFIRMED_FRAUD order is a person's verdict: the score is refreshed,
 *    nothing else moves.
 *  - At or above the review threshold the order is FLAGGED — unless a person
 *    CLEARED it and every signal firing now is one they dismissed: a cleared
 *    order re-flags only on a NEW signal.
 *  - Below the threshold the review stands as it was: a flag is a question
 *    for a person, and the score drifting down does not answer it.
 *  - A hold only with `autoHold` on (watch mode leaves it off), at the hold
 *    threshold, on an open order not already held, and only when the order
 *    is being flagged on this score (a cleared order with no new signal is
 *    not held).
 */
export function screeningOutcome(
  current: { status: string; reviewStatus: OrderRiskReviewValue | null; clearedKeys: readonly string[]; heldAt: Date | null },
  scored: { score: number; signals: readonly OrderSignalRow[] },
  settings: ScreeningSettings,
): ScreeningOutcome {
  const band = bandFor(scored.score, settings);
  const cleared = new Set(current.clearedKeys);
  const newSignals = firingKeys(scored.signals).filter((key) => !cleared.has(key));
  if (current.reviewStatus === 'CONFIRMED_FRAUD') return { band, reviewStatus: 'CONFIRMED_FRAUD', newlyFlagged: false, hold: false, newSignals };
  const open = current.status !== 'COMPLETED' && current.status !== 'CANCELLED';
  if (scored.score < settings.reviewThreshold) return { band, reviewStatus: current.reviewStatus, newlyFlagged: false, hold: false, newSignals };
  if (current.reviewStatus === 'CLEARED' && newSignals.length === 0) return { band, reviewStatus: 'CLEARED', newlyFlagged: false, hold: false, newSignals };
  const hold = settings.autoHold && scored.score >= settings.holdThreshold && open && !current.heldAt;
  return { band, reviewStatus: 'FLAGGED', newlyFlagged: current.reviewStatus !== 'FLAGGED', hold, newSignals };
}
