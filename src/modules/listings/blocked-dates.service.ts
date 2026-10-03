import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import type { ListingBlockedDate } from '../../shared/database';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import { assertCanEditListing, type ListingActor } from './listings.service';
import { slotsHeldFor } from './slots.service';

/**
 * BD-1 (DR 12, 25 Sep 2026) — dates a publisher takes a spot off the market.
 *
 * The website's Availability calendar draws three things on a site's row:
 * the bookings (orders and live reservations, which `slots.service` already
 * counts), and the dates the publisher blocked by hand — a renovation, a
 * festival the venue keeps for itself, a wall being repainted. A block holds
 * EVERY slot of the spot over its range: browse shows "0 left", checkout
 * calls it a clash, and placement refuses it, all through the one count in
 * `slot-holds.ts`, so a blocked date never reads as free anywhere.
 *
 * A block cannot be laid over a booking — the advertiser paid for those
 * days — and two blocks cannot overlap: the publisher extends or removes the
 * one that is there. Dates are calendar days (`@db.Date`), inclusive at both
 * ends, and a block may not end before today.
 */

export type BlockedDateInput = { from: string; to: string; reason?: string | null | undefined };

export type BlockedDateView = {
  id: string;
  listingId: string;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  reason: string | null;
  createdAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A year is as far ahead as a block may reach — anything longer is a delisting, not a block. */
export const MAX_BLOCK_DAYS = 366;

/** YYYY-MM-DD → the UTC midnight the `@db.Date` column stores. */
export function dayOf(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', `Dates are YYYY-MM-DD; got "${value}"`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'VALIDATION_ERROR', `"${value}" is not a calendar date`);
  }
  return date;
}

export const dayString = (date: Date): string => date.toISOString().slice(0, 10);

/** The inclusive day range as the slot window the hold count reads (to the last millisecond of `to`). */
export function windowOfDays(from: Date, to: Date): { from: Date; to: Date } {
  return { from, to: new Date(to.getTime() + DAY_MS - 1) };
}

export function toBlockedDateView(row: ListingBlockedDate): BlockedDateView {
  return { id: row.id, listingId: row.listingId, from: dayString(row.from), to: dayString(row.to), reason: row.reason, createdAt: row.createdAt.toISOString() };
}

/**
 * The refusals a block can meet, as a pure rule the tests pin: the order of
 * the two days, the past, the length, and an overlap with a block already
 * there. Bookings are checked against the live count afterwards.
 */
export function blockProblem(
  from: Date,
  to: Date,
  existing: readonly Pick<ListingBlockedDate, 'from' | 'to'>[],
  today = new Date(),
): { code: 'DATES_REVERSED' | 'DATES_PAST' | 'DATES_TOO_LONG' | 'DATES_BLOCKED'; message: string } | null {
  if (to.getTime() < from.getTime()) return { code: 'DATES_REVERSED', message: 'The block ends before it starts.' };
  const todayDay = dayOf(dayString(today));
  if (to.getTime() < todayDay.getTime()) return { code: 'DATES_PAST', message: 'These dates are already behind you.' };
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_BLOCK_DAYS) {
    return { code: 'DATES_TOO_LONG', message: `A block runs a year at most. Pause the listing to take it off the market for longer.` };
  }
  const clash = existing.find((block) => block.from.getTime() <= to.getTime() && block.to.getTime() >= from.getTime());
  if (clash) {
    return { code: 'DATES_BLOCKED', message: `${dayString(clash.from)} to ${dayString(clash.to)} is already blocked. Remove that block first, or block the days around it.` };
  }
  return null;
}

export async function listBlockedDates(listingId: string, actor: ListingActor): Promise<BlockedDateView[]> {
  await assertCanEditListing(listingId, actor);
  return (await repository.findBlockedDates(listingId)).map(toBlockedDateView);
}

export async function addBlockedDate(listingId: string, input: BlockedDateInput, actor: ListingActor): Promise<BlockedDateView> {
  await assertCanEditListing(listingId, actor);
  const from = dayOf(input.from);
  const to = dayOf(input.to);
  const existing = await repository.findBlockedDates(listingId);
  const problem = blockProblem(from, to, existing);
  if (problem) throw new ApiError(problem.code === 'DATES_BLOCKED' ? 409 : 400, problem.code, problem.message, { from: input.from, to: input.to });

  // A booking on any of the days: the advertiser holds those days, the block cannot.
  const held = await slotsHeldFor([listingId], windowOfDays(from, to));
  if ((held.get(listingId) ?? 0) > 0) {
    throw new ApiError(409, 'DATES_BOOKED', 'A booking or a hold sits on these dates. A block cannot cover days an advertiser holds.', { from: input.from, to: input.to });
  }

  const reason = input.reason?.trim() || null;
  const row = await repository.createBlockedDate({ listingId, from, to, reason, createdById: actor.userId });
  await logActivity(actor.userId, 'LISTING_DATES_BLOCKED', {
    module: 'listings',
    targetType: 'Listing',
    targetId: listingId,
    metadata: { blockId: row.id, from: input.from, to: input.to, reason },
  });
  return toBlockedDateView(row);
}

export async function removeBlockedDate(listingId: string, blockId: string, actor: ListingActor): Promise<BlockedDateView> {
  await assertCanEditListing(listingId, actor);
  const row = await repository.findBlockedDate(blockId);
  if (!row || row.listingId !== listingId) throw new ApiError(404, 'NOT_FOUND', 'No such block on this listing');
  await repository.deleteBlockedDate(blockId);
  await logActivity(actor.userId, 'LISTING_DATES_UNBLOCKED', {
    module: 'listings',
    targetType: 'Listing',
    targetId: listingId,
    metadata: { blockId, from: dayString(row.from), to: dayString(row.to) },
  });
  return toBlockedDateView(row);
}
