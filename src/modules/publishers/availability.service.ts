import { ApiError } from '../../shared/errors';
import { prismaPublishersRepository as repository } from './prisma-publishers.repository';
import type { AvailabilityRows } from './publishers.repository';

/**
 * BD-1 (DR 12 board 10) — the publisher's availability calendar.
 *
 * One read for the grid: every spot of the publisher as a row, and over the
 * window the bookings on it (orders that hold a slot, the way `slots.service`
 * counts them), the live campaign reservations (a hold: reserved, not yet
 * paid), and the dates the publisher blocked by hand. A spot still in review
 * carries its `status`, which the grid draws as "In review · unavailable for
 * booking". Nothing is computed here that browse would count differently —
 * the same clauses feed both.
 */

export type AvailabilityBooking = {
  orderId: string | null;
  campaignName: string | null;
  advertiserName: string | null;
  /** YYYY-MM-DD; null when the order has no dates and occupies the spot outright. */
  from: string | null;
  to: string | null;
  kind: 'BOOKED' | 'HOLD';
  status: string;
};

export type AvailabilityListing = {
  id: string;
  displayId: string | null;
  title: string;
  category: string;
  city: string | null;
  slotsTotal: number;
  status: string;
  bookings: AvailabilityBooking[];
  blocks: { id: string; from: string; to: string; reason: string | null }[];
};

export type AvailabilityView = { from: string; to: string; listings: AvailabilityListing[] };

const DAY_MS = 24 * 60 * 60 * 1000;
/** A quarter is as wide as the grid asks; a wider read is paged by the calendar itself. */
export const MAX_WINDOW_DAYS = 92;

const day = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null);

function parseDay(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', `Dates are YYYY-MM-DD; got "${value}"`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', `"${value}" is not a calendar date`);
  return date;
}

/** The window the read is asked for: today and the fortnight after it when nothing is given; never wider than a quarter. */
export function windowOf(query: { from?: string | undefined; to?: string | undefined }, now = new Date()): { from: Date; to: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = parseDay(query.from, today);
  const to = parseDay(query.to, new Date(from.getTime() + 13 * DAY_MS));
  if (to.getTime() < from.getTime()) throw new ApiError(400, 'VALIDATION_ERROR', 'The window ends before it starts.');
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_WINDOW_DAYS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Ask for at most ${MAX_WINDOW_DAYS} days at a time.`);
  }
  return { from, to: new Date(to.getTime() + DAY_MS - 1) };
}

/** Pure: the repository's rows folded onto the listings, one entry per spot in the order the inventory lists them. */
export function shapeAvailability(window: { from: Date; to: Date }, rows: AvailabilityRows): AvailabilityView {
  const byListing = new Map<string, AvailabilityListing>();
  for (const listing of rows.listings) {
    byListing.set(listing.id, {
      id: listing.id,
      displayId: listing.displayId,
      title: listing.title,
      category: listing.category,
      city: listing.city,
      slotsTotal: listing.slotsTotal,
      status: listing.status,
      bookings: [],
      blocks: [],
    });
  }
  for (const order of rows.orders) {
    byListing.get(order.listingId)?.bookings.push({
      orderId: order.id,
      campaignName: order.campaignName ?? order.campaignSpot?.campaign.name ?? null,
      advertiserName: order.advertiser.advertiserProfile?.companyName ?? order.advertiser.advertiserProfile?.name ?? order.advertiser.name ?? null,
      from: day(order.startDate),
      to: day(order.endDate),
      kind: 'BOOKED',
      status: order.status,
    });
  }
  for (const spot of rows.reservations) {
    byListing.get(spot.listingId)?.bookings.push({
      orderId: null,
      campaignName: spot.campaign.name,
      advertiserName: spot.campaign.advertiser.companyName ?? spot.campaign.advertiser.name ?? null,
      from: day(spot.startDate),
      to: day(spot.endDate),
      kind: 'HOLD',
      status: 'RESERVED',
    });
  }
  for (const block of rows.blocks) {
    byListing.get(block.listingId)?.blocks.push({ id: block.id, from: day(block.from)!, to: day(block.to)!, reason: block.reason });
  }
  return { from: day(window.from)!, to: window.to.toISOString().slice(0, 10), listings: [...byListing.values()] };
}

export async function myAvailability(userId: string, query: { from?: string | undefined; to?: string | undefined }): Promise<AvailabilityView> {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'No publisher profile on this account yet');
  const window = windowOf(query);
  return shapeAvailability(window, await repository.findAvailability(publisher.id, window));
}
