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

/** BD-1: the blocks the publisher laid over the window, as one Prisma clause. Days are inclusive at both ends. */
export function blockedDatesWhere(window: SlotWindow): Prisma.ListingBlockedDateWhereInput {
  return { from: { lte: window.to }, to: { gte: window.from } };
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
  /** BD-1: a block holds the spot's whole loop — `slotsTotal` of it; absent on the older callers. */
  blocks?: readonly { listingId: string; listing: { slotsTotal: number } }[];
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
  // BD-1: a blocked day takes every slot; `slotsLeft` floors at zero, so a
  // block beside a booking never counts below "none left".
  for (const block of rows.blocks ?? []) add(block.listingId, Math.max(1, block.listing.slotsTotal));
  return held;
}

/* ------------------------------------------------------------------ */
/* AV-1 (the owner, 27 Sep 2026): counted per day, not over the range   */
/* ------------------------------------------------------------------ */

/**
 * One hold on a listing with the days it covers. Dates are whole UTC days
 * (a flight's `startDate`/`endDate` are the first and the LAST day, stored
 * at midnight; a block's `from`/`to` are `@db.Date`), so a hold covers
 * every day from `day(from)` to `day(to)` inclusive. A hold with no start
 * or no end runs to that edge of the window, the way it always held the
 * spot.
 */
export type DatedHold = { listingId: string; quantity: number; from: Date | null; to: Date | null; blocked?: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;
/** The UTC day number of an instant. */
export const dayNumber = (instant: Date): number => Math.floor(instant.getTime() / DAY_MS);
/** "2026-10-11" for a UTC day number. */
export const dayKey = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The days a window covers, first and last inclusive. */
export function windowDays(window: SlotWindow): { first: number; last: number } {
  return { first: dayNumber(window.from), last: dayNumber(window.to) };
}

/**
 * The held count of ONE listing on every day of the window — index 0 is
 * the window's first day. A digital loop's slots are per day, so two
 * bookings that never run together never add up (before AV-1 every hold
 * touching the window was summed, and a billboard booked 1–10 Oct read
 * "full" for all of October).
 */
export function dailyHolds(holds: readonly DatedHold[], window: SlotWindow): number[] {
  const { first, last } = windowDays(window);
  const length = Math.max(0, last - first + 1);
  const diff = new Array<number>(length + 1).fill(0);
  for (const hold of holds) {
    const from = Math.max(first, hold.from ? dayNumber(hold.from) : first);
    const to = Math.min(last, hold.to ? dayNumber(hold.to) : last);
    if (to < from) continue;
    diff[from - first]! += hold.quantity;
    diff[to - first + 1]! -= hold.quantity;
  }
  const days: number[] = [];
  let running = 0;
  for (let index = 0; index < length; index += 1) {
    running += diff[index]!;
    days.push(running);
  }
  return days;
}

/** The days of the window a publisher block covers — index 0 is the first day. */
export function blockedDays(holds: readonly DatedHold[], window: SlotWindow): boolean[] {
  return dailyHolds(holds.filter((hold) => hold.blocked).map((hold) => ({ ...hold, quantity: 1 })), window).map((count) => count > 0);
}

/** Per listing, the busiest day of the window — what "slots held over these dates" means. */
export function peakSlotHolds(holds: readonly DatedHold[], window: SlotWindow): Map<string, number> {
  const byListing = new Map<string, DatedHold[]>();
  for (const hold of holds) byListing.set(hold.listingId, [...(byListing.get(hold.listingId) ?? []), hold]);
  const peak = new Map<string, number>();
  for (const [listingId, own] of byListing) {
    const days = dailyHolds(own, window);
    const top = days.length ? Math.max(...days) : 0;
    if (top > 0) peak.set(listingId, top);
  }
  return peak;
}

/** The rows the three hold reads answer, turned into dated holds (an order holds its spot's quantity, a block the whole loop). */
export type DatedHoldRows = {
  orders: readonly { listingId: string; startDate: Date | null; endDate: Date | null; campaignSpot: { quantity: number } | null }[];
  reservations: readonly { listingId: string; quantity: number; startDate: Date | null; endDate: Date | null }[];
  blocks: readonly { listingId: string; from: Date; to: Date; listing: { slotsTotal: number } }[];
};

export function datedHolds(rows: DatedHoldRows): DatedHold[] {
  return [
    ...rows.orders.map((order) => ({ listingId: order.listingId, quantity: Math.max(1, order.campaignSpot?.quantity ?? 1), from: order.startDate, to: order.endDate })),
    ...rows.reservations.filter((spot) => spot.quantity > 0).map((spot) => ({ listingId: spot.listingId, quantity: spot.quantity, from: spot.startDate, to: spot.endDate })),
    ...rows.blocks.map((block) => ({ listingId: block.listingId, quantity: Math.max(1, block.listing.slotsTotal), from: block.from, to: block.to, blocked: true })),
  ];
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

