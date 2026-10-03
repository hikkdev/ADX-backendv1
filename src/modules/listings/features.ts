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
    '/api/v1/listings/browse/categories',
    '/api/v1/listings/browse/venues',
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

feature('listings.blocked-dates', {
  surfaces: ['APP_USER', 'WEBSITE', 'CONSOLE', 'BACKEND'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'BD-1: the dates a publisher takes a spot off the market by hand — a block holds every slot, so browse, checkout and placement read the days as taken.',
  routes: ['/api/v1/listings/:listingId/blocked-dates'],
});

feature('listings.insights', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The listing page’s Performance (3 Oct 2026): saves, bookings, enquiries, scans, GMV, occupancy and stars over a window, with the day series.',
  routes: ['/api/v1/listings/:listingId/insights'],
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

feature('listings.spot-views', {
  surfaces: ['WEBSITE', 'APP_USER', 'CONSOLE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "LD-1 (3 Oct 2026): spot-page views — the website's spot page and marketplace detail and the app's listing screen count a view per open (bots, ADX staff and the spot's own publisher and agent left out, one visitor per day), and the listing page's Performance draws Views and Unique visitors.",
  routes: ['/api/v1/listings/:displayIdOrId/view'],
});

feature('listings.vehicle-rc', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "A vehicle put up as an ad spot, checked against the RC register: while the spot is being registered (nothing stored, and the registered owner's name never returned — only how closely it matches the publisher's) and again on the listing afterwards, where the full answer is recorded and audited.",
  routes: ['/api/v1/listings/vehicle-rc/check', '/api/v1/listings/:listingId/vehicle-rc/verify'],
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
