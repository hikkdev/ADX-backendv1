/**
 * Reviews — Lot D (Q5/Q19/Q104/Q112/Q137): what people say about a spot or
 * an agent, every review anchored on the transaction that earned it.
 *
 * `reviewPartyRouter` hangs off the parties' own prefixes and is mounted on
 * the API router root ahead of `campaigns`, `listings`, `orders` and
 * `agents`; `reviewRouter` is the desk under `/reviews`. See reviews.routes.
 */
export { reviewPartyRouter, reviewRouter } from './reviews.routes';

/**
 * Fills the `agents` module's AgentReviewPort — the ledger's "publisher
 * rated you" rows — from bootstrap, because this module imports `agents` to
 * write the rating snapshot and a cycle would be the alternative.
 */
export { recentAgentReviews } from './reviews.service';

/**
 * E7-2: fills the `campaigns` module's SpotReviewPort — `reviewed` /
 * `reviewId` on each spot of GET /campaigns/:id — from bootstrap, for the
 * same reason: this module imports `campaigns` to gate a spot review.
 */
export { reviewIdsForCampaignSpots } from './reviews.service';
export type { PublicReview, AgentRatingEligibility } from './reviews.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
