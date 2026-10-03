import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { toListPage } from '../../../shared/pagination';
import { findUserLabels } from '../../users';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { placedByFrom } from '../orders.queries';
import type { OrderRiskPatch, OrderRiskState } from '../orders.repository';
import type { RiskReviewQuery } from '../orders.schema';
import { autoAssignAgent } from '../assignment/assignment.service';
import { isClosedOrder, reviewNoticeFor } from './order-hold';

/**
 * Order fraud screening — the orders side (the owner, 2 Oct 2026).
 *
 * The order owns its risk and hold columns; `fraud` scores the order and
 * runs the review desk, and writes through the functions here. What a hold
 * means is the orders module's to say, so the gates live here too:
 *
 *   - no agent is offered the job, accepts it, or has it reassigned;
 *   - ADX cannot approve it (the step that records the agent's commission);
 *   - the publisher's daily earning skips it (`payouts`' accrual reads the
 *     hold through its own spot query and catches the days up on release).
 *
 * A hold is reversible and is never a cancellation: the order keeps its
 * status, and on release it walks on from where it stood — an order that
 * reached PENDING_AGENT while held is offered to an agent then.
 *
 * Parties never see any of it. The columns are in the client's global omit;
 * a party's read of a held order carries `reviewNotice` — the one neutral
 * line below — and nothing else.
 */

/* ── Reads ──────────────────────────────────────────────────────────────── */

/** The order with its risk and hold columns, or null. For `fraud` and the console's reads. */
export async function getOrderRiskState(orderId: string): Promise<OrderRiskState | null> {
  return repository.findRiskState(orderId);
}

/** Just the hold — what a party read turns into `reviewNotice`. */
export async function getOrderHold(orderId: string): Promise<{ heldAt: Date | null } | null> {
  return repository.findHold(orderId);
}

/** A person on the screening, by name: who reviewed, who held. Null for nobody (an automatic hold is `heldById: null`). */
export type RiskPerson = { id: string; name: string | null };

/** The admin detail's "Fraud screening" card: every risk column, plus the two people by name and the party's line. */
export type OrderRiskView = Omit<OrderRiskState, 'id' | 'displayId' | 'status' | 'advertiserId' | 'listingId' | 'agentId' | 'budget' | 'startDate' | 'endDate' | 'createdAt' | 'campaignSpot'> & {
  riskReviewedBy: RiskPerson | null;
  heldBy: RiskPerson | null;
  reviewNotice: string | null;
};

export async function getOrderRiskView(orderId: string): Promise<OrderRiskView | null> {
  const state = await repository.findRiskState(orderId);
  if (!state) return null;
  const ids = [state.riskReviewedById, state.heldById].filter((id): id is string => !!id);
  const labels = ids.length ? await findUserLabels(ids).catch(() => new Map<string, { id: string; name: string | null }>()) : new Map<string, { id: string; name: string | null }>();
  const person = (id: string | null): RiskPerson | null => (id ? (labels.get(id) ?? { id, name: null }) : null);
  const { id: _id, displayId: _d, status: _s, advertiserId: _a, listingId: _l, agentId: _g, budget: _b, startDate: _sd, endDate: _ed, createdAt: _c, campaignSpot: _cs, ...risk } = state;
  return { ...risk, riskReviewedBy: person(state.riskReviewedById), heldBy: person(state.heldById), reviewNotice: reviewNoticeFor(state) };
}

/** `GET /orders/fraud-review`: the board's row shape (with `placedBy`) plus the risk columns, and a count per tab. */
export async function listRiskReview(query: RiskReviewQuery) {
  const { items, total, counts } = await repository.findRiskReviewPage(query);
  const rows = items.map(({ advertiser, ...row }) => ({ ...row, placedBy: placedByFrom(advertiser) }));
  return toListPage(rows, total, counts, query);
}

/** Open orders by id, a page at a time — what the nightly re-screen walks. */
export async function openOrderIdsForScreening(afterId: string | null, limit: number): Promise<string[]> {
  return repository.findOpenOrderIds(afterId, limit);
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

/** The screening's and the desk's write: risk and review columns. Holds go through `holdOrder` / `releaseOrderHold`. */
export async function recordOrderRisk(orderId: string, patch: OrderRiskPatch): Promise<OrderRiskState> {
  return repository.updateRisk(orderId, patch);
}

/**
 * Holds an open order. `byUserId` null is the screening's automatic hold.
 * 404 on no order, 409 on a finished one or one already held.
 */
export async function holdOrder(orderId: string, input: { byUserId: string | null; reason: string; at?: Date }): Promise<OrderRiskState> {
  const before = await repository.findRiskState(orderId);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (isClosedOrder(before.status)) throw new ApiError(409, 'CONFLICT', 'This order is completed or cancelled — there is nothing left to hold.');
  if (before.heldAt) throw new ApiError(409, 'CONFLICT', 'This order is already on hold.');
  const held = await repository.holdIfOpen(orderId, { heldAt: input.at ?? new Date(), heldById: input.byUserId, holdReason: input.reason });
  if (!held) throw new ApiError(409, 'CONFLICT', 'This order is already on hold, or has just finished.');
  return (await repository.findRiskState(orderId))!;
}

/**
 * Lifts a hold. 404 on no order, 409 when it is not held. The order walks
 * on from where it stood: one that reached PENDING_AGENT while held, with
 * no offer out (none was made, or the one out lapsed), is offered now — the same auto-assignment print-ready
 * runs, fire-and-forget.
 */
export async function releaseOrderHold(orderId: string): Promise<OrderRiskState> {
  const before = await repository.findRiskState(orderId);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (!before.heldAt) throw new ApiError(409, 'CONFLICT', 'This order is not on hold.');
  await repository.releaseIfHeld(orderId);
  const after = (await repository.findRiskState(orderId))!;
  if (after.status === 'PENDING_AGENT') {
    const offers = await repository.findAssignments(orderId).catch(() => []);
    if (!offers.some((offer) => offer.status === 'PENDING')) {
      autoAssignAgent(orderId).catch((err) => logger.error('autoAssignAgent after a hold was released failed', { orderId, err }));
    }
  }
  return after;
}
