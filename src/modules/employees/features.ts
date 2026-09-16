import { feature } from '../../shared/features';

/**
 * Features of `employees` — Lot G (answer 144).
 *
 * Internal staff records (Lot E, Q98/Q143; Lot G, Q122: departments).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('hr.employees', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The employee register: create, read, edit, remove — ADMIN at every route.',
  routes: ['/api/v1/employees'],
});
