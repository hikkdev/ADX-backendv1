import { feature } from '../../shared/features';

/**
 * Features of `schedule` — Lot G (answer 144).
 *
 * The staff diary (Lot E, Q72/Q99).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('hr.schedule', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Schedule entries for staff and agents, with the field overlay and the audit trail read back.',
  routes: ['/api/v1/schedule'],
});
