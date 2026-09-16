import { feature } from '../../shared/features';

/**
 * Features of `pricing` — Lot G (answer 144).
 *
 * What a listing should cost — and the taxonomy, factors, market data, surge
 * and cities that question needs.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('pricing.engine', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The evaluation, comparables, the price indicator on a listing, and the pricing settings.',
  routes: ['/api/v1/pricing', '/api/v1/pricing/settings'],
});

feature('pricing.vocabulary', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Media types, size classes, materials, venue types, the match log and the proposals.',
  routes: [
    '/api/v1/pricing/media-types',
    '/api/v1/pricing/size-classes',
    '/api/v1/pricing/materials',
    '/api/v1/pricing/venue-types',
    '/api/v1/pricing/vocabulary',
  ],
});

feature('pricing.binding-factors', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot E (Q125): pricing factors in ADVISORY or BINDING mode; a binding apply reprices within maxBindingChangePct or raises a price case.',
  routes: ['/api/v1/pricing/factors', '/api/v1/pricing/listings/:id/factors'],
});

feature('pricing.market-data', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Market data imports and their revocation.',
  routes: ['/api/v1/pricing/market-data'],
});

feature('pricing.surge', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Surge events, the scraper sources that feed them and the job that runs the due ones.',
  routes: ['/api/v1/pricing/surge', '/api/v1/pricing/scraper-sources'],
  jobs: ['event-scraper'],
});

feature('pricing.cities', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The city table and its per-city settings.',
  routes: ['/api/v1/pricing/cities'],
});
