import { ApiError } from '../../shared/errors';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import { windowFor, type SlotWindow, type SlotHoldOptions } from './slot-holds';

export { SLOT_FREE_ORDER_STATUSES, slotHoldingOrdersWhere, liveReservationsWhere, todayWindow, windowFor } from './slot-holds';
export type { SlotWindow, SlotHoldOptions } from './slot-holds';

/**
 * Lot G (Q116/136) — slots.
 *
 * The two Prisma clauses behind the rule live in `slot-holds.ts`, imported by
 * this module's repository and re-exported here for `campaigns`' repository,
 * so the count is the same wherever it is taken.
 *
 * A digital screen runs a loop: six advertisers share the same face, each
 * for a few seconds in turn, and the publisher decides how many the loop
 * carries. A static wall carries one. `Listing.slotsTotal` is that number,
 * availability is "n slots left", and the rate stays per slot per day — a
 * six-slot screen at ₹1,000 is ₹1,000 to each of six advertisers, not
 * ₹1,000 split six ways.
 *
 * ## Which spots carry a loop
 *
 * `ListingCategory` is INDOOR / OUTDOOR / TRANSIT / MEDIA — where the spot
 * is, not what it is made of — so the category cannot decide. What can is
 * the same evidence browse's `display=DIGITAL` facet reads: the sub-type the
 * publisher typed, and the media type the classifier resolved (its name, or
 * the catalogue heading it sits under — "Digital Displays"). A spot is
 * digital when any of the three names a screen: "digital", "LED", "LCD",
 * "screen" as a word of its own ("Screen-printed vinyl" is not a loop). A
 * spot that carries no loop is refused above one slot, at create and at
 * every patch that touches the count or the evidence.
 *
 * ## What holds a slot
 *
 * Over a window, a slot is held by every order on the listing whose flight
 * overlaps it and that is still running — anything but DRAFT, CANCELLED and
 * PUBLISHER_REJECTED, and a COMPLETED order (installed) only until its
 * `endDate`; a completed order with no end date holds nothing, because
 * `endCampaign` writes the end date to free the spot — plus every live
 * campaign reservation (a RESERVED spot under an unexpired `reservedUntil`,
 * Lot C Q88), which has no order yet. A BOOKED or LIVE campaign spot has an
 * order behind it and is counted once, through that order. An order with
 * no dates overlaps every window, the way it always occupied the whole spot.
 */

/** A "screen" on its own, or the three words that only ever mean one. */
const LOOP_WORD = /digital|\bled\b|\blcd\b|(?<![\w-])screen(?![\w-])/i;

/** What the loop decision reads — off the listing, and off its media type. */
export type LoopEvidence = {
  subType: string | null | undefined;
  mediaType: { name: string; formatGroup: string | null } | null;
};

export function carriesLoop(evidence: LoopEvidence): boolean {
  if (evidence.subType && LOOP_WORD.test(evidence.subType)) return true;
  if (!evidence.mediaType) return false;
  return LOOP_WORD.test(evidence.mediaType.name) || Boolean(evidence.mediaType.formatGroup && LOOP_WORD.test(evidence.mediaType.formatGroup));
}

/**
 * Refuses a slot count a spot cannot carry. Only asked when the count would
 * be above one — a static wall at 1 is the default and needs no evidence.
 */
export async function assertSlotsAllowed(slotsTotal: number, listing: { subType: string | null | undefined; mediaTypeId: string | null | undefined }): Promise<void> {
  if (slotsTotal <= 1) return;
  const mediaType = listing.mediaTypeId ? await repository.mediaTypeLoopHint(listing.mediaTypeId) : null;
  if (carriesLoop({ subType: listing.subType, mediaType })) return;
  throw new ApiError(
    400,
    'VALIDATION_ERROR',
    'Only a digital spot carries more than one slot — a static wall shows one advertiser at a time. Name the screen in the sub-type or the media type, or leave the count at 1.',
    { slotsTotal }
  );
}

/**
 * How many slots each of these listings has held over the window. A listing
 * with nothing on it is simply absent from the map — read it as zero.
 */
export async function slotsHeldFor(listingIds: string[], window: SlotWindow): Promise<Map<string, number>> {
  if (listingIds.length === 0) return new Map();
  return repository.slotsHeld(listingIds, window);
}

/** `slotsTotal - held`, never below zero. */
export function slotsLeft(slotsTotal: number, held: number | undefined): number {
  return Math.max(0, slotsTotal - (held ?? 0));
}

/**
 * Of these listings, the ones with no slot left over the window — what
 * checkout calls a clash and placement refuses. One count per listing,
 * against its own `slotsTotal`; a listing it cannot find is not in the
 * answer, because there is nothing to clash with.
 */
export async function listingsWithNoSlotLeft(
  listings: { id: string; slotsTotal: number }[],
  window: SlotWindow,
  options: SlotHoldOptions = {},
): Promise<string[]> {
  if (listings.length === 0) return [];
  const held = await repository.slotsHeld(listings.map((listing) => listing.id), window, options);
  return listings.filter((listing) => slotsLeft(listing.slotsTotal, held.get(listing.id)) === 0).map((listing) => listing.id);
}

/**
 * Whether this listing has a slot left over the dates — the order's flight,
 * or today when it has none. What `orders` asks at placement.
 */
export async function hasSlotLeft(
  listing: { id: string; slotsTotal: number },
  dates: { from?: Date | undefined; to?: Date | undefined },
  options: SlotHoldOptions = {},
): Promise<boolean> {
  const full = await listingsWithNoSlotLeft([listing], windowFor(dates.from, dates.to), options);
  return full.length === 0;
}
