import { feature } from '../../shared/features';

/**
 * Features of `ledger` — Lot G (answer 144).
 *
 * Double entry under every wallet. The routes live on payouts' finance router;
 * the concept is this module's.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('finance.ledger', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The ledger read, the verify walk and a reversal by finance.',
  routes: ['/api/v1/finance/ledger'],
});
