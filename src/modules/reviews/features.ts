import { feature } from '../../shared/features';

/**
 * Features of `reviews` — Lot G (answer 144).
 *
 * A spot's or an agent's stars, anchored on the order or campaign spot that
 * earned them (Lot D, Q104/Q112).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('marketplace.reviews', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'marketplace',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Reviews of a spot and of an agent, the eligibility read, the console desk that hides with a reason.',
  routes: [
    '/api/v1/reviews',
    '/api/v1/campaigns/:id/spots/:spotId/review',
    '/api/v1/listings/browse/:listingId/reviews',
    '/api/v1/orders/:id/rate-agent',
    '/api/v1/agents/me/reviews',
    '/api/v1/agents/:id/reviews',
  ],
});
