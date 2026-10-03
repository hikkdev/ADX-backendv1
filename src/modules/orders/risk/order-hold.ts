import { prismaOrdersRepository as repository } from '../prisma-orders.repository';

/**
 * Order fraud screening (2 Oct 2026): the hold as the order's own steps ask
 * about it — the gates, and the words. A leaf of the module (it reads the
 * repository and nothing else), so the assignment, approval and risk
 * services can all import it without a ring.
 */

export { ORDER_REVIEW_NOTICE, reviewNoticeFor } from '../orders.redact';

/** The 409 a person at ADX meets on a held order's money-moving step. */
export const ORDER_ON_HOLD_MESSAGE = 'This order is on hold for review. Release it (or clear it) on Orders › Fraud review before it moves on.';

/** Where an order has finished, one way or the other: nothing to hold, nothing to screen. */
export const CLOSED_ORDER_STATUSES = ['COMPLETED', 'CANCELLED'] as const;
export const isClosedOrder = (status: string) => (CLOSED_ORDER_STATUSES as readonly string[]).includes(status);


/* ── The gates ───────────────────────────────────────────────────────────── */

/** Whether the order is held; false for an order that does not exist (the caller's own read decides that). */
export async function isOrderHeld(orderId: string): Promise<boolean> {
  return !!(await repository.findHold(orderId))?.heldAt;
}

/**
 * The gate on a step ADX takes: the sentinel `ORDER_ON_HOLD`, which
 * `orders.errors` answers as 409 ORDER_ON_HOLD with the desk's sentence.
 */
export async function assertOrderNotHeld(orderId: string): Promise<void> {
  if (await isOrderHeld(orderId)) throw new Error('ORDER_ON_HOLD');
}

/**
 * The gate on a step a party takes (an agent accepting the offer): the
 * sentinel `ORDER_UNDER_REVIEW` — the same 409 ORDER_ON_HOLD code, with the
 * neutral line instead of the desk's sentence.
 */
export async function assertOrderNotHeldForParty(orderId: string): Promise<void> {
  if (await isOrderHeld(orderId)) throw new Error('ORDER_UNDER_REVIEW');
}

