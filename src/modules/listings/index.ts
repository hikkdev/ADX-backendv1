/**
 * Listings — advertising inventory a publisher offers.
 *
 * `similarListingsHandler` is exported separately because
 * GET /api/v1/listings/:id/similar is mounted directly on the API router,
 * ahead of and outside `listingRouter`, so that it stays unauthenticated.
 * See bootstrap/register-modules.
 */
export { listingRouter, savedSpacesRouter, spotPageRouter } from './listings.routes';
export { similarListingsHandler } from './listings.controller';

/**
 * Lot D (Q104): `reviews` recomputes a spot's stars on every review and
 * hands the aggregate here — the columns stay this module's.
 */
export { setListingRatingSnapshot } from './listings.service';
export type { BrowseCard } from './browse.service';

/** Used by `publishers` for GET /publishers/:publisherId/listings. */
export { getListingsForPublisher } from './listings.service';

/**
 * Used by `orders`, which reads a listing when placing an order and flips its
 * availability as the campaign starts and ends.
 */
export { getListingWithPublisher, setListingAvailability, getListingById } from './listings.service';
/** K-B1: by listing id, for the QR desk (registered on qr's ref-label port by bootstrap). */
export { findListingLabels } from './listings.service';

/** Used by `account-lifecycle`: a closed publisher's spots go INACTIVE, never away. */
export { retireListingsForPublisher } from './listings.service';

/**
 * Lot E: the two writes the pricing and rate-card ports need, registered by
 * bootstrap. `updateListing` is how a BINDING factor reprices — the same
 * door a typed rate uses, surge stamp and all; `unpublishListing` is what a
 * rejected CARD_REVISION case does after its grace (Q97), audited here.
 */
export { updateListing, unpublishListing } from './listings.service';

/**
 * Lot U: the listing importer (`party-imports`) creates every imported spot
 * through `createListing` — never a row of its own — under the act rule an
 * agent's own listing creation uses, and reads the vocabulary enum for its
 * column table.
 */
export { createListing, assertCanCreateForPublisher } from './listings.service';
export type { ListingDraft, ListingActor } from './listings.service';
export { LISTING_CATEGORIES } from './listings.schema';

/**
 * Lot D (Q138): the content taxonomy. `campaigns` reads a campaign's
 * `contentCategoryId` against each booked spot's stance at creative submit
 * (the venue-stance check), and offers the seeded list to the wizard.
 */
export { listContentCategories, getContentRules } from './listings.service';
export type { ContentRule } from './listings.repository';
export type { ListingWithPublisher } from './listings.repository';

/**
 * G7 (Q109) / Y-B: the audience panel, for `campaigns`' analytics and
 * `geo`'s city profile — the stored snapshot per (listing, vendor, month),
 * each vendor asked once, blended on read. `storedAudienceForListings`
 * never calls a vendor. No access check here: the campaign read and the
 * console have already decided who may see it.
 */
export { audienceForSpots, currentPeriod, storedAudienceForListings } from './audience.service';
export type { SpotAudience, SpotsAudience } from './audience.service';

/**
 * Lot G (Q116/136): slots. `orders` counts a listing's holds at placement
 * and `campaigns` at checkout, both against `slotsTotal` and both through
 * the one rule; the two Prisma clauses are exported for `campaigns`'
 * repository so its clash query counts what browse counts.
 */
export { hasSlotLeft, listingsWithNoSlotLeft, slotHoldingOrdersWhere, liveReservationsWhere, windowFor, SLOT_FREE_ORDER_STATUSES } from './slots.service';
export type { SlotWindow, SlotHoldOptions } from './slots.service';
/**
 * G10: the count itself, over any Prisma client — for the orders and
 * campaigns repositories, which take it inside the transaction that holds
 * the listing's advisory lock so the count and the write are one act.
 * A repository-to-repository export: nothing outside a prisma-*.repository
 * may call it.
 */
export { slotsHeldWith } from './prisma-listings.repository';
export type { SlotCountClient } from './prisma-listings.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
