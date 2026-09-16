import type { Prisma } from '../../shared/database';

/**
 * Lot G (Q116/136) — what holds a slot, as Prisma clauses.
 *
 * Kept apart from `slots.service` so the repositories can import the rule
 * without the service and the repository importing each other. The rule
 * itself is documented on `slots.service`; this file is its two clauses and
 * the window arithmetic they share.
 */

/** The order statuses that hold nothing. Everything else is running. */
export const SLOT_FREE_ORDER_STATUSES = ['DRAFT', 'CANCELLED', 'PUBLISHER_REJECTED'] as const;

export type SlotWindow = { from: Date; to: Date };

/** What a count may leave out: a campaign's own reservations, when it asks about itself. */
export type SlotHoldOptions = { excludeCampaignId?: string; now?: Date };

/**
 * The orders that hold a slot over the window, as one Prisma clause — the
 * rule above, written once. Both the listings and the campaigns repositories
 * count with it, so a spot never reads "1 left" on browse and "none" at
 * checkout.
 */
export function slotHoldingOrdersWhere(window: SlotWindow): Prisma.OrderWhereInput {
  return {
    AND: [
      { OR: [{ startDate: null }, { startDate: { lte: window.to } }] },
      {
        OR: [
          // Running: overlaps the window by its end date, or has none.
          { status: { notIn: [...SLOT_FREE_ORDER_STATUSES, 'COMPLETED'] }, OR: [{ endDate: null }, { endDate: { gte: window.from } }] },
          // Installed: holds the slot until its end date, and nothing without one.
          { status: 'COMPLETED', endDate: { gte: window.from } },
        ],
      },
    ],
  };
}

/** The live campaign reservations that hold a slot over the window (Lot C, Q88), as one Prisma clause. */
export function liveReservationsWhere(window: SlotWindow, options: SlotHoldOptions = {}): Prisma.CampaignSpotWhereInput {
  return {
    status: 'RESERVED',
    reservedUntil: { gt: options.now ?? new Date() },
    ...(options.excludeCampaignId ? { campaignId: { not: options.excludeCampaignId } } : {}),
    AND: [
      { OR: [{ startDate: null }, { startDate: { lte: window.to } }] },
      { OR: [{ endDate: null }, { endDate: { gte: window.from } }] },
    ],
  };
}

/**
 * G10: what the two hold queries answer, before the sum. An order holds the
 * quantity of the campaign spot behind it — one when it was placed on its
 * own — and a live reservation holds its own `quantity`, summed by the
 * database. Kept as data so the arithmetic is a pure function the tests pin.
 */
export type SlotHoldRows = {
  orders: readonly { listingId: string; campaignSpot: { quantity: number } | null }[];
  reservations: readonly { listingId: string; _sum: { quantity: number | null } }[];
};

/**
 * The slots held per listing: quantities summed, never rows counted. A
 * six-slot loop with one campaign spot of three on it has three left, not
 * five — the spot was priced per slot and it holds what it paid for.
 */
export function sumSlotHolds(rows: SlotHoldRows): Map<string, number> {
  const held = new Map<string, number>();
  const add = (listingId: string, quantity: number) => held.set(listingId, (held.get(listingId) ?? 0) + quantity);
  for (const order of rows.orders) add(order.listingId, Math.max(1, order.campaignSpot?.quantity ?? 1));
  for (const group of rows.reservations) {
    if (group._sum.quantity) add(group.listingId, group._sum.quantity);
  }
  return held;
}

/** The UTC day around an instant — what "today" means when no window is asked for. */
export function todayWindow(now = new Date()): SlotWindow {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from, to };
}

/**
 * The window a read is asked for: both bounds when given, the day of the
 * start when only that is, today's day when neither is. An end without a
 * start runs from today.
 */
export function windowFor(from?: Date, to?: Date, now = new Date()): SlotWindow {
  if (from && to) return { from, to };
  if (from) return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1) };
  const today = todayWindow(now);
  if (to) return { from: today.from, to };
  return today;
}

