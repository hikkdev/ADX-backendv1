import { feature } from '../../shared/features';

/**
 * Features of `audit` — Lot G (answer 144).
 *
 * The audit trail read back.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.audit-trail', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The activity log, per target and as a CSV export.',
  routes: ['/api/v1/audit'],
});
