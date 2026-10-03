import { ApiError } from '../../../shared/errors';
import type { Prisma } from '../../../shared/database';
import { logActivity } from '../../../shared/audit';
import { logger } from '../../../shared/logging';
import { money, type Money } from '../../../shared/money';
import { getPlatformSettings } from '../../app-config';
import { permissionsFor } from '../../access-control';
import { getAdvertiserForUser, requestRefund } from '../../advertisers';
import { cancelSpotsForOrders } from '../../campaigns';
import { createNotification } from '../../notifications';
import {
  cancelOrder,
  getOrderRiskState,
  holdOrder,
  isClosedOrder,
  listRiskReview,
  openOrderIdsForScreening,
  recordOrderRisk,
  releaseOrderHold,
  type OrderRiskState,
  type RiskReviewQuery,
} from '../../orders';
import { listAdminUserIds, systemUserId } from '../../users';
import { prismaFraudRepository as cases } from '../prisma-fraud.repository';
import { prismaFraudSignalsIndex as partyIndex } from '../prisma-fraud-signals.repository';
import { openCaseRecord } from '../fraud.service';
import { evaluateSignals, type StoredSignal } from '../signals';
import type { FraudSubjectType } from '../fraud.schema';
import {
  combineOrderScore,
  bandFor,
  firingKeys,
  linksBetween,
  orderSignals,
  partyRows,
  screeningOutcome,
  type OrderRiskBandValue,
  type OrderSignalRow,
  type ScreeningOutcome,
  type ScreeningSettings,
} from './order-signals';
import { prismaOrderScreeningIndex as index } from './prisma-order-screening.repository';

/**
 * Order fraud screening — the service (the owner, 2 Oct 2026).
 *
 * "Watch mode, no automatic holds … I agree on both." Every order is scored
 * — on placement, when the money behind it is taken, nightly while it is
 * open, and on demand — and the score is written on the order with every
 * signal behind it. At the review threshold the order is FLAGGED and the
 * fraud desk (holders of the fraud desk's read permission) is told in-app.
 * With automatic holds on (they ship OFF) a score at the hold threshold also
 * HOLDS the order, reversibly. That is the furthest automation goes:
 * cancelling as fraud and suspending a party are a person's acts, here and
 * on the suspension desk.
 *
 * Parties never hear of any of it. No notification, push, email or SMS goes
 * to a party about a flag or a hold; a held order reads, to them, "Your
 * order is being reviewed — we'll update you shortly"; and a cancellation
 * as fraud reaches them through the ordinary cancel with a neutral reason.
 */

export type Actor = { sub: string; roles: string[] };

/** The neutral words a cancellation as fraud carries to the parties (and onto `cancellationReason`). */
export const PARTY_CANCEL_REASON = 'Cancelled after an ADX review';

/** Where the advertisement is up: from the installation proof on. A cancel then is a dispute's to unwind. */
export const LIVE_ORDER_STATUSES = ['PENDING_OTP', 'PENDING_APPROVAL', 'COMPLETED'] as const;

const RECENT_REFUND_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');
const orderName = (order: { id: string; displayId: string | null }) => order.displayId ?? order.id;

export async function screeningSettings(): Promise<ScreeningSettings> {
  return (await getPlatformSettings()).fraud.orderScreening;
}

/* ── Scoring ───────────────────────────────────────────────────────────── */

/** A run's cache of party signals — the nightly re-screen evaluates each party once, however many orders it has. */
export type PartyMemo = Map<string, Promise<StoredSignal[]>>;

async function partySignals(type: FraudSubjectType, id: string, now: Date, memo?: PartyMemo): Promise<StoredSignal[]> {
  const key = `${type}:${id}`;
  const cached = memo?.get(key);
  if (cached) return cached;
  const work = (async () => {
    const subject = await partyIndex.resolveSubject({ type, id });
    if (!subject) return [];
    return (await evaluateSignals(subject, { index: partyIndex, now })).signals;
  })();
  memo?.set(key, work);
  return work;
}

export type OrderScore = { score: number; band: OrderRiskBandValue; signals: OrderSignalRow[] };

/**
 * `scoreOrder(orderId)` — the score, its band and every signal, explained.
 * Reads only: the facts are gathered here, the arithmetic is
 * `order-signals.ts`. 404 on an order that does not exist.
 */
export async function scoreOrder(orderId: string, now = new Date(), memo?: PartyMemo): Promise<OrderScore & { state: OrderRiskState }> {
  const state = await getOrderRiskState(orderId);
  if (!state) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  const settings = await screeningSettings();
  return { ...(await scoreState(state, settings, now, memo)), state };
}

async function scoreState(state: OrderRiskState, settings: ScreeningSettings, now: Date, memo?: PartyMemo): Promise<OrderScore> {
  const [advertiser, publisher] = await Promise.all([index.advertiserForLogin(state.advertiserId), index.publisherOfListing(state.listingId)]);
  const [advertiserSignals, publisherSignals] = await Promise.all([
    advertiser ? partySignals('ADVERTISER', advertiser.id, now, memo) : Promise.resolve([] as StoredSignal[]),
    publisher ? partySignals('PUBLISHER', publisher.id, now, memo) : Promise.resolve([] as StoredSignal[]),
  ]);
  const placedAt = state.createdAt;
  const since = advertiser
    ? [advertiser.createdAt, advertiser.userCreatedAt].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null
    : await index.loginCreatedAt(state.advertiserId);
  const window = state.startDate && state.endDate ? { start: state.startDate, end: state.endDate } : null;
  const [recentOrderCount, duplicates, payments, priorFraud] = await Promise.all([
    index.countOrdersPlaced(state.advertiserId, new Date(placedAt.getTime() - settings.velocityMinutes * 60_000), placedAt),
    index.overlappingOrders({ userId: state.advertiserId, listingId: state.listingId, excludeOrderId: state.id, window, placedAt }),
    advertiser
      ? index.paymentHistory({ advertiserId: advertiser.id, campaignId: state.campaignSpot?.campaignId ?? null, placedAt, since: new Date(now.getTime() - RECENT_REFUND_DAYS * DAY_MS) })
      : Promise.resolve(null),
    index.priorConfirmedFraud({ advertiserId: advertiser?.id ?? null, publisherId: publisher?.id ?? null, advertiserUserId: state.advertiserId, excludeOrderId: state.id }),
  ]);
  const links = linksBetween({ advertiserSignals, publisherSignals, advertiser, publisher });
  const signals: OrderSignalRow[] = [
    ...partyRows(advertiserSignals, 'ADVERTISER'),
    ...partyRows(publisherSignals, 'PUBLISHER'),
    ...orderSignals({ value: state.budget, placedAt, advertiserSince: since, recentOrderCount, duplicates, payments, links, priorFraud }, settings),
  ];
  const score = combineOrderScore(signals);
  return { score, band: bandFor(score, settings), signals };
}

/* ── Screening: the score written, and what it does ──────────────────────── */

export type ScreenTrigger = 'PLACED' | 'PAYMENT' | 'NIGHTLY' | 'MANUAL';

export type ScreenResult = {
  before: OrderRiskState;
  after: OrderRiskState;
  score: OrderScore;
  outcome: ScreeningOutcome;
  /** True when this screening held the order (only ever with automatic holds on). */
  held: boolean;
};

/**
 * Scores the order and applies what the score says: the score and signals
 * written, FLAGGED at the review threshold (a cleared order only on a new
 * signal), held only with `autoHold` on. Automatic triggers skip a finished
 * order and do nothing while screening is switched off; `MANUAL` (the
 * desk's Rescore) always scores. Returns null when it skipped.
 */
export async function screenOrder(
  orderId: string,
  options: { trigger: ScreenTrigger; now?: Date; memo?: PartyMemo; tellDesk?: boolean },
): Promise<ScreenResult | null> {
  const now = options.now ?? new Date();
  const settings = await screeningSettings();
  const manual = options.trigger === 'MANUAL';
  if (!settings.enabled && !manual) return null;
  const before = await getOrderRiskState(orderId);
  if (!before) {
    if (manual) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
    return null;
  }
  if (isClosedOrder(before.status) && !manual) return null;

  const score = await scoreState(before, settings, now, options.memo);
  const outcome = screeningOutcome(
    { status: before.status, reviewStatus: before.riskReviewStatus, clearedKeys: before.riskClearedSignalKeys, heldAt: before.heldAt },
    score,
    settings,
  );
  let after = await recordOrderRisk(orderId, {
    riskScore: score.score.toFixed(3),
    riskSignals: score.signals as unknown as Prisma.InputJsonValue,
    riskBand: score.band,
    riskScoredAt: now,
    riskReviewStatus: outcome.reviewStatus,
  });

  let held = false;
  if (outcome.hold) {
    try {
      after = await holdOrder(orderId, { byUserId: null, reason: `Automatic hold: risk score ${score.score.toFixed(3)} at or above the hold threshold ${settings.holdThreshold}.`, at: now });
      held = true;
      const actor = await systemUserId().catch(() => null);
      if (actor) {
        await logActivity(actor, 'ORDER_HELD', {
          module: 'fraud',
          targetType: 'Order',
          targetId: orderId,
          metadata: { automatic: true, trigger: options.trigger, score: score.score.toFixed(3), holdThreshold: settings.holdThreshold },
        }).catch(() => undefined);
      }
    } catch (err) {
      // Held a moment ago by somebody else, or finished: the flag stands either way.
      logger.info('Automatic hold not applied', { orderId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (outcome.newlyFlagged && options.tellDesk !== false) await tellDesk([{ order: after, score: score.score, signals: score.signals }]);
  return { before, after, score, outcome, held };
}

/**
 * The background screening placement and payment ask for through `orders`'
 * port — never throws: a failure is logged and the order proceeds.
 */
export async function screenOrderInBackground(orderId: string, trigger: 'PLACED' | 'PAYMENT'): Promise<void> {
  try {
    await screenOrder(orderId, { trigger });
  } catch (err) {
    logger.warn('Order screening failed; the order proceeds', { orderId, trigger, err: err instanceof Error ? err.message : String(err) });
  }
}

/* ── Telling the desk ──────────────────────────────────────────────────── */

/** The fraud desk's read permission — the one `fraud`'s case routes ask for. */
export const FRAUD_DESK_PERMISSION = 'kyc.view';

/** Who hears of a new flag: the admins whose console role holds the desk's read permission. */
async function deskUserIds(): Promise<string[]> {
  const admins = await listAdminUserIds().catch(() => [] as string[]);
  const holders = await Promise.all(
    admins.map(async (userId) => ((await permissionsFor(userId, ['ADMIN']).catch(() => [] as string[])).includes(FRAUD_DESK_PERMISSION) ? userId : null)),
  );
  return holders.filter((id): id is string => !!id);
}

/** Plain words for the top reasons on a flagged order. */
function topReasons(signals: readonly OrderSignalRow[], n = 2): string {
  return [...signals]
    .filter((s) => s.value !== null && s.value > 0)
    .sort((a, b) => b.weight * (b.value ?? 0) - a.weight * (a.value ?? 0))
    .slice(0, n)
    .map((s) => s.detail)
    .join(' ');
}

/** In-app only, to the desk; one notification per person for the batch. Never a party. */
async function tellDesk(flagged: { order: OrderRiskState; score: number; signals: readonly OrderSignalRow[] }[]): Promise<void> {
  if (flagged.length === 0) return;
  const people = await deskUserIds();
  if (people.length === 0) return;
  const one = flagged.length === 1 ? flagged[0]! : null;
  const title = one ? `Order ${orderName(one.order)} flagged for review` : `${flagged.length} orders flagged for review`;
  const message = (
    one
      ? `Risk score ${one.score.toFixed(2)}. ${topReasons(one.signals)}`
      : flagged
          .slice(0, 5)
          .map((f) => `${orderName(f.order)} (${f.score.toFixed(2)})`)
          .join(', ')
  ).slice(0, 500);
  await Promise.all(
    people.map((userId) =>
      createNotification({ userId, type: 'SYSTEM', title, message, suggestedAction: 'Open Orders › Fraud review', relatedId: flagged[0]!.order.id }).catch(() => undefined),
    ),
  );
}

/* ── The nightly re-screen ─────────────────────────────────────────────── */

export type RescreenReport = { scanned: number; flagged: number; held: number; failed: number; skipped: boolean };

const RESCREEN_PAGE = 200;

/**
 * Every open order (not COMPLETED or CANCELLED), re-scored — a page at a time,
 * each party's signals evaluated once for the run. A cleared order re-flags
 * only on a new signal (`screeningOutcome`). The orders newly flagged are
 * told to the desk once, as one batch. One order failing never stops the run.
 */
export async function runOrderRescreen(now = new Date()): Promise<RescreenReport> {
  const settings = await screeningSettings();
  const report: RescreenReport = { scanned: 0, flagged: 0, held: 0, failed: 0, skipped: !settings.enabled };
  if (!settings.enabled) return report;
  const memo: PartyMemo = new Map();
  const newlyFlagged: { order: OrderRiskState; score: number; signals: readonly OrderSignalRow[] }[] = [];
  let after: string | null = null;
  for (;;) {
    const ids = await openOrderIdsForScreening(after, RESCREEN_PAGE);
    if (ids.length === 0) break;
    for (const id of ids) {
      try {
        const result = await screenOrder(id, { trigger: 'NIGHTLY', now, memo, tellDesk: false });
        if (!result) continue;
        report.scanned += 1;
        if (result.outcome.newlyFlagged) {
          report.flagged += 1;
          newlyFlagged.push({ order: result.after, score: result.score.score, signals: result.score.signals });
        }
        if (result.held) report.held += 1;
      } catch (err) {
        report.failed += 1;
        logger.warn('Nightly order re-screen failed for an order', { orderId: id, err: err instanceof Error ? err.message : String(err) });
      }
    }
    after = ids[ids.length - 1]!;
    if (ids.length < RESCREEN_PAGE) break;
  }
  await tellDesk(newlyFlagged);
  logger.info('Order re-screen finished', { ...report });
  return report;
}

/* ── The desk's acts ───────────────────────────────────────────────────── */

export type ReviewChange = { before: OrderRiskState; after: OrderRiskState };

function requireAdmin(actor: Actor) {
  if (!isAdmin(actor)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX reviews an order');
}

async function requireOrder(orderId: string): Promise<OrderRiskState> {
  const state = await getOrderRiskState(orderId);
  if (!state) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  return state;
}

/** `POST /orders/:id/hold { reason }` — a person's hold. Reversible; 409 on a finished or already-held order. */
export async function holdForReview(orderId: string, actor: Actor, reason: string, now = new Date()): Promise<ReviewChange> {
  requireAdmin(actor);
  const before = await requireOrder(orderId);
  const after = await holdOrder(orderId, { byUserId: actor.sub, reason, at: now });
  return { before, after };
}

/** `POST /orders/:id/release { note? }` — the hold lifted; the review stands as it was. 409 when not held. */
export async function releaseFromReview(orderId: string, actor: Actor, note: string | undefined, now = new Date()): Promise<ReviewChange> {
  requireAdmin(actor);
  const before = await requireOrder(orderId);
  let after = await releaseOrderHold(orderId);
  if (note) after = await recordOrderRisk(orderId, { riskReviewNote: note, riskReviewedById: actor.sub, riskReviewedAt: now });
  return { before, after };
}

/**
 * `POST /orders/:id/clear { note? }` — "not fraud": released if held, CLEARED,
 * and the signals firing now remembered so the same reasons do not flag it
 * again. 409 on an order already confirmed as fraud.
 */
export async function clearReview(orderId: string, actor: Actor, note: string | undefined, now = new Date()): Promise<ReviewChange> {
  requireAdmin(actor);
  const before = await requireOrder(orderId);
  if (before.riskReviewStatus === 'CONFIRMED_FRAUD') throw new ApiError(409, 'CONFLICT', 'This order was confirmed as fraud and cancelled; it cannot be cleared.');
  if (before.heldAt) await releaseOrderHold(orderId);
  const stored = Array.isArray(before.riskSignals) ? (before.riskSignals as unknown as OrderSignalRow[]) : [];
  const cleared = [...new Set([...before.riskClearedSignalKeys, ...firingKeys(stored)])];
  const after = await recordOrderRisk(orderId, {
    riskReviewStatus: 'CLEARED',
    riskReviewedById: actor.sub,
    riskReviewedAt: now,
    riskReviewNote: note ?? null,
    riskClearedSignalKeys: cleared,
  });
  return { before, after };
}

export type CancelImpact = {
  orderId: string;
  status: string;
  /** False when the cancel would be refused; `blockedReason` says why. */
  cancellable: boolean;
  blockedReason: string | null;
  /**
   * The advertiser's money: the unused days of the order's spot, raised as a
   * refund request to the advertiser's wallet (a second person at finance
   * releases it) — or nothing, when the campaign's money is still only held
   * (it is released with the campaign) or nothing is unused.
   */
  refund: { amount: Money; to: 'ADVERTISER_WALLET' | 'NONE'; note: string };
  /**
   * The publisher's side. `amount` is what the cancel itself reverses — nothing:
   * it stops further days, and what was already credited (`accruedToDate`)
   * stays; reversing that is a finance decision.
   */
  publisherReversal: { amount: Money; accruedToDate: Money; note: string };
  /** The agents the cancel releases — the one holding the job and anyone with an offer open. */
  agentsReleased: number;
  /** What happens to the campaign, in plain words, one line each; empty for a direct booking. */
  campaignEffects: string[];
  /** The same, as data: the campaign the order was raised from; null for a direct booking. */
  campaign: { campaignId: string; reference: string; spotsCancelled: number; refundNeeded: boolean } | null;
};

function cancelBlockedReason(state: OrderRiskState): { code: 'CONFLICT' | 'ORDER_LIVE'; message: string } | null {
  if (state.status === 'CANCELLED') return { code: 'CONFLICT', message: 'This order is already cancelled.' };
  if ((LIVE_ORDER_STATUSES as readonly string[]).includes(state.status)) {
    return {
      code: 'ORDER_LIVE',
      message: 'The advertisement on this order is already up. Cancelling now would not undo what has run — raise a dispute on the order instead, where refunds and reversals are decided case by case.',
    };
  }
  return null;
}

/**
 * `GET /orders/:id/cancel-impact` — what "Cancel as fraud" would do, read
 * only. The campaign side is the cancel's own computation run as a dry run
 * (`campaigns.cancelSpotsForOrders(…, { dryRun: true })`), so the dialog
 * shows exactly the figure the cancel raises.
 */
export async function cancelImpact(orderId: string, now = new Date()): Promise<CancelImpact> {
  const state = await requireOrder(orderId);
  const blocked = cancelBlockedReason(state);
  const [refunds, accrued, agentsReleased] = await Promise.all([
    cancelSpotsForOrders([orderId], now, { dryRun: true }),
    index.accruedForOrder(orderId),
    index.agentsOnOrder(orderId, state.agentId),
  ]);
  const campaign = refunds[0] ?? null;
  const owed = campaign && campaign.refundNeeded && Number(campaign.amount) > 0;
  return {
    orderId,
    status: state.status,
    cancellable: !blocked,
    blockedReason: blocked?.message ?? null,
    refund: owed
      ? { amount: campaign.amount, to: 'ADVERTISER_WALLET', note: 'The unused days, raised as a refund request to the advertiser’s wallet — finance releases it.' }
      : {
          amount: money(0),
          to: 'NONE',
          note: campaign ? (campaign.refundNeeded ? 'Nothing unused to refund.' : 'The campaign’s money is still held, not taken; it is released with the campaign.') : 'A direct booking: no campaign money to return.',
        },
    publisherReversal: {
      amount: money(0),
      accruedToDate: money(accrued),
      note: 'The cancel stops the publisher earning further days on this order. What was already credited stays; reversing it is a finance decision.',
    },
    agentsReleased: blocked ? 0 : agentsReleased,
    campaignEffects: campaign
      ? [
          `Campaign ${campaign.reference}: ${campaign.spotIds.length === 1 ? 'this spot is' : `${campaign.spotIds.length} spots are`} cancelled; the rest of the campaign runs on.`,
          owed
            ? `The unused days (${campaign.amount}) are raised as a refund request to the advertiser’s wallet.`
            : campaign.refundNeeded
              ? 'Nothing unused to refund.'
              : 'The campaign’s money is still only held; it is released with the campaign.',
        ]
      : [],
    campaign: campaign ? { campaignId: campaign.campaignId, reference: campaign.reference, spotsCancelled: campaign.spotIds.length, refundNeeded: campaign.refundNeeded } : null,
  };
}

export type ConfirmFraudResult = ReviewChange & {
  refunds: { campaignId: string; amount: Money; requested: boolean; note?: string }[];
};

/**
 * `POST /orders/:id/confirm-fraud { reason }` — a person's verdict.
 * CONFIRMED_FRAUD, then cancelled through the ordinary cancel (the listing
 * freed, the parties told — with the neutral reason, never the word), the
 * campaign side cancelled and the unused days raised as one refund request,
 * exactly as a suspension's STOP_OPEN_WORK does it; any hold is lifted (the
 * cancel supersedes it). 409 on a cancelled order, and 409 ORDER_LIVE once
 * the advertisement is up — a dispute's to unwind.
 */
export async function confirmFraud(orderId: string, actor: Actor, reason: string, now = new Date()): Promise<ConfirmFraudResult> {
  requireAdmin(actor);
  const before = await requireOrder(orderId);
  const blocked = cancelBlockedReason(before);
  if (blocked) throw new ApiError(409, blocked.code, blocked.message);

  await recordOrderRisk(orderId, { riskReviewStatus: 'CONFIRMED_FRAUD', riskReviewedById: actor.sub, riskReviewedAt: now, riskReviewNote: reason });
  try {
    await cancelOrder(orderId, PARTY_CANCEL_REASON, actor.sub);
  } catch (err) {
    // The verdict stands; the cancel did not — say so rather than pretend.
    logger.error('Cancel as fraud: the order could not be cancelled', { orderId, err });
    throw new ApiError(409, 'CONFLICT', 'The order was marked as fraud but could not be cancelled. Cancel it from the order page.');
  }
  if (before.heldAt) await releaseOrderHold(orderId).catch(() => undefined);

  const refunds: ConfirmFraudResult['refunds'] = [];
  const owed = await cancelSpotsForOrders([orderId], now).catch((err) => {
    logger.warn('Cancel as fraud: the campaign side could not be cancelled', { orderId, err: String(err) });
    return [];
  });
  for (const refund of owed) {
    if (!refund.refundNeeded || Number(refund.amount) <= 0) {
      refunds.push({ campaignId: refund.campaignId, amount: refund.amount, requested: false, note: refund.refundNeeded ? 'Nothing unused to refund' : 'Held money released, no refund needed' });
      continue;
    }
    try {
      await requestRefund(refund.advertiserId, { amount: refund.amount, reason: 'OTHER', note: `Order ${orderName(before)}: ${PARTY_CANCEL_REASON}` }, actor.sub);
      refunds.push({ campaignId: refund.campaignId, amount: refund.amount, requested: true });
    } catch (err) {
      const note = err instanceof ApiError ? err.message : 'Refund request failed';
      logger.warn('Cancel as fraud: the refund request could not be raised', { orderId, campaignId: refund.campaignId, note });
      refunds.push({ campaignId: refund.campaignId, amount: refund.amount, requested: false, note });
    }
  }
  const after = await requireOrder(orderId);
  return { before, after, refunds };
}

/**
 * `POST /orders/:id/fraud-case` — a case on the advertiser behind the order:
 * the order is attached (a note) to the case already open against them, or a
 * case is opened (kind ORDER_FRAUD) naming the order, its score and its top
 * signals. `fraudCaseId` goes on the order. An order already pointing at an
 * open case answers that case. 409 when the placing login has no advertiser
 * profile to open a case against.
 */
export async function openOrderFraudCase(orderId: string, actor: Actor, now = new Date()) {
  requireAdmin(actor);
  const before = await requireOrder(orderId);
  if (before.fraudCaseId) {
    const existing = await cases.findSummaryById(before.fraudCaseId);
    if (existing && existing.status !== 'CONFIRMED' && existing.status !== 'DISMISSED') {
      return { before, after: before, fraudCase: existing, attached: true, opened: false };
    }
  }
  const advertiser = await getAdvertiserForUser(before.advertiserId);
  if (!advertiser) throw new ApiError(409, 'CONFLICT', 'The login that placed this order holds no advertiser profile to open a case against.');

  const signals = Array.isArray(before.riskSignals) ? (before.riskSignals as unknown as OrderSignalRow[]) : [];
  const line = `Order ${orderName(before)} (${before.id})${before.riskScore !== null ? `, risk score ${String(before.riskScore)}` : ''}.${signals.length ? ` ${topReasons(signals, 3)}` : ''}`;
  const open = await cases.findOpenForSubject('ADVERTISER', advertiser.id);
  let fraudCase = open;
  let opened = false;
  if (open) {
    await cases.addNote({ caseId: open.id, byUserId: actor.sub, body: `Attached from the order review: ${line}`.slice(0, 4000) });
  } else {
    fraudCase = await openCaseRecord(
      {
        subjectType: 'ADVERTISER',
        subjectId: advertiser.id,
        kind: 'ORDER_FRAUD',
        summary: `Opened from the order review: ${line}`.slice(0, 4000),
        openedByUserId: actor.sub,
        assignedToUserId: null,
        disputeId: null,
      },
      now,
    );
    opened = true;
  }
  const after = await recordOrderRisk(orderId, { fraudCaseId: fraudCase!.id });
  return { before, after, fraudCase: fraudCase!, attached: !opened, opened };
}

/** `GET /orders/fraud-review` — through `orders`, which owns the row. */
export const listFraudReview = (query: RiskReviewQuery) => listRiskReview(query);
