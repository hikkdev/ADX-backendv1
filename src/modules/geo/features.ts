import { feature } from '../../shared/features';

/**
 * Features of `geo` — Lot G (answer 144).
 *
 * The one door to Google Maps.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('platform.maps', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Geocoding, reverse geocoding, place search and place detail through the Maps key.',
  routes: ['/api/v1/geo', '/api/v1/app/maps'],
});

feature('geo.rollout', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot V: the all-India geography catalogue (GeoNames), the city rollout stages and their six function switches, the readiness read, the bulk rollout, the seed, and the hourly wind-down of a withdrawn city. Lot X-B: the city key on every party table, and the unresolved typed strings the console folds in. Lot X-L: the city key backfill from the console. Y-B: the city audience profile, the blend of both audience vendors over the city spots.',
  routes: [
    '/api/v1/geo/summary',
    '/api/v1/geo/unresolved',
    '/api/v1/geo/backfill-city-keys',
    '/api/v1/geo/map',
    '/api/v1/geo/states',
    '/api/v1/geo/cities',
    '/api/v1/geo/rollout',
    '/api/v1/geo/seed',
    '/api/v1/app/geo',
  ],
  jobs: ['city-winddown'],
});
