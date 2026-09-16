import { feature } from '../../shared/features';

/**
 * Features of `packages` — Lot G (answer 144).
 *
 * The four-step package sale beside the booking flow (Lot D, Q94/Q123).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('packages.sales', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Package quotes and sales: create, resend, cancel, accept terms, pay or record a payment; the active entitlements; Lot J2: free trials, the auto-renew switch and the daily renewal sweep.',
  routes: ['/api/v1/packages'],
  jobs: ['package-renewal'],
});

feature('packages.catalogue', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The package catalogue: plans per tier and the add-ons, ADMIN and audited.',
  routes: ['/api/v1/packages/catalogue'],
});

feature('packages.payment-link', {
  surfaces: ['WEBSITE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The payment link sent by SMS — public, tokenised, short by design.',
  routes: ['/p/:token'],
});
