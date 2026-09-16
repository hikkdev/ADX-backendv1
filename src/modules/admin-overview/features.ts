import { feature } from '../../shared/features';

/**
 * Features of `admin-overview` — Lot G (answer 144).
 *
 * The console's month in numbers (Lot B, Q30/Q80).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('console.overview', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The dashboard aggregates across campaigns, sales, the ledger and the parties.',
  routes: ['/api/v1/admin/overview'],
});
