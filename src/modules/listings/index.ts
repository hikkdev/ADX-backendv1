/**
 * Listings — advertising inventory a publisher offers.
 *
 * `similarListingsHandler` is exported separately because
 * GET /api/v1/listings/:id/similar is mounted directly on the API router,
 * ahead of and outside `listingRouter`, so that it stays unauthenticated.
 * See bootstrap/register-modules.
 */
export { listingRouter } from './listings.routes';
export { similarListingsHandler } from './listings.controller';

/** Used by `publishers` for GET /publishers/:publisherId/listings. */
export { getListingsForPublisher } from './listings.service';
