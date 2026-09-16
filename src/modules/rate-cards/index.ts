/**
 * Rate cards — ADX's approved position on what a kind of spot is worth.
 *
 * Distinct from `pricing`, which suggests from comparables and never blocks
 * anything. This one governs: a number a person signed off, and the gate DR 10
 * puts in front of publishing.
 */
export { rateCardRouter } from './rate-cards.routes';

/** Used by the listing publish path. Passes when no card covers the listing. */
export { assertPublishable, checkGate } from './rate-cards.service';

/** Lot U: the floor for a kind of spot before a listing exists — the listing importer's per-row warning. */
export { floorFor } from './rate-cards.service';

/** Used by the quote builder, so a quote prices from the card the gate uses. */
export { effectiveCardEntry } from './rate-cards.service';

/**
 * Lot E: `belowFloorFlags` stamps the admin listings table; `raisePriceCase`
 * is what a BINDING pricing factor calls, through pricing's port, when the
 * move it wants is above the cap. `isBelowFloor` reads a verdict as the badge.
 */
export { belowFloorFlags, isBelowFloor, raisePriceCase } from './rate-cards.service';
export type { GateVerdict, GateView, GateCase, ImpactRow } from './rate-cards.service';

/**
 * Lot E (Q97): a rejected CARD_REVISION case unpublishes the listing through
 * this port, registered by bootstrap, because `listings` imports this module.
 */
export { registerListingEnforcementPort, resetListingEnforcementPort } from './listing-enforcement.port';
export type { ListingEnforcementPort } from './listing-enforcement.port';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
