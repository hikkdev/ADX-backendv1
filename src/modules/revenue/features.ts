import { feature } from '../../shared/features';

/**
 * Features of `revenue` — Lot G (answer 144).
 *
 * What happens to the number: commission, subscriptions, overrides, fees, tax
 * — and the quote and price lock the checkout reads.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('revenue.commission', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Commission rates by category or media type, publisher subscriptions and per-publisher overrides.',
  routes: [
    '/api/v1/revenue',
    '/api/v1/revenue/commission',
    '/api/v1/revenue/subscriptions',
    '/api/v1/revenue/overrides',
  ],
});

/*
 * Lot J (B1), the owner's decision of 14 Sep 2026: the publisher plan
 * catalogue, its console editor, and the self-service purchase on the phone.
 * A kill switch: off, the order routes and the phone's screen answer 404
 * while the catalogue read, the editor and every subscription already sold
 * carry on — the commission ladder reads the subscription, not the switch.
 */
feature('revenue.publisher-plans', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'finance',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'Publisher subscription plans: the priced catalogue and its editor, self-service orders paid from the wallet, the phone\'s subscription screen, and the daily expiry sweep.',
  routes: ['/api/v1/revenue/plans', '/api/v1/revenue/subscription-orders', '/api/v1/revenue/subscriptions/me'],
  jobs: ['publisher-subscription'],
});

feature('revenue.price-locks', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The checkout quote and the price lock that holds it while the advertiser pays.',
  routes: ['/api/v1/revenue/quote', '/api/v1/revenue/price-locks'],
});

feature('revenue.fees-and-tax', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The fee schedule and the tax settings.',
  routes: ['/api/v1/revenue/fees', '/api/v1/revenue/tax'],
});
