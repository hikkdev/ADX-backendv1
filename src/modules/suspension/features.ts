import { feature } from '../../shared/features';

/**
 * Features of `suspension` — Lot G (answer 144).
 *
 * Modular suspension (Lot A): the paths hang off the party.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('safety.suspension', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Suspend and reinstate a listing, publisher, advertiser or agent by scope; the read of what is in force.',
  routes: [
    '/api/v1/suspension',
    '/api/v1/listings/:id/suspend',
    '/api/v1/listings/:id/reinstate',
    '/api/v1/publishers/:id/suspend',
    '/api/v1/publishers/:id/reinstate',
    '/api/v1/advertisers/:id/suspend',
    '/api/v1/advertisers/:id/reinstate',
    '/api/v1/agents/:id/suspend',
    '/api/v1/agents/:id/reinstate',
  ],
});
