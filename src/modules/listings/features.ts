import { feature } from '../../shared/features';

/**
 * Features of `listings` — Lot G (answer 144).
 *
 * The inventory a publisher offers and the ways it is found, priced, reviewed
 * and shared.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('listings.inventory', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A publisher\'s listings: create, edit, submit, the content rules, the console list.',
  routes: ['/api/v1/listings'],
});

feature('listings.browse', {
  surfaces: ['APP_USER', 'APP_AGENT'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The advertiser\'s discovery: browse, detail, similar spots, the content categories.',
  routes: [
    '/api/v1/listings/browse',
    '/api/v1/listings/:id/similar',
    '/api/v1/listings/content-categories',
  ],
});

feature('listings.saved-spaces', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot D (Q5): an advertiser saves a spot and reads the shortlist back.',
  routes: ['/api/v1/listings/browse/:listingId/save', '/api/v1/advertisers/:advertiserId/saved'],
});

feature('listings.review-desk', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The listing review queue: read, send back, publish.',
  routes: [
    '/api/v1/listings/review',
    '/api/v1/listings/:listingId/review',
    '/api/v1/listings/:listingId/send-back',
    '/api/v1/listings/:listingId/publish',
  ],
});

feature('listings.suggested-rate', {
  surfaces: ['APP_USER', 'APP_AGENT'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot E: the advisory rate on the publisher\'s own listing, and taking it.',
  routes: ['/api/v1/listings/me'],
});

feature('listings.reprice-log', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'E10-2: the LISTING_REPRICED_BY_FACTOR rows shaped for the Pricing tab.',
  routes: ['/api/v1/listings/:listingId/reprice-log'],
});

feature('listings.spot-page', {
  surfaces: ['WEBSITE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'E11-2: the public spot page a shared link opens, metered by IP.',
  routes: ['/s/:displayId'],
});

feature('marketplace.instant-booking', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'marketplace',
  kind: 'FEATURE',
  launch: 'dark',
  description:
    'Publishers may opt a listing into automatic acceptance (Q6): allowed, not recommended. Off: the switch, the filter and the bolt chip are not drawn, and an instant order is refused 409 FEATURE_OFF.',
  aliases: ['instant-booking'],
  // G12-B: the app's two renderings — `default` draws the switch plain,
  // `recommended` draws it with the nudge. Declared here so the console can
  // set either before the app manifest is synced.
  variants: ['default', 'recommended'],
});
