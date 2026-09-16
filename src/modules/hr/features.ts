import { feature } from '../../shared/features';

/**
 * Features of `hr` — Lot G (answer 144).
 *
 * The one HR record kept in-house (holidays) and the people read over
 * employees + agents (Lot E, Q98/Q99).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('hr.holidays', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The year\'s holidays, seeded at boot, editable by ops; the schedule reads them.',
  routes: ['/api/v1/hr/holidays'],
});

feature('hr.departments', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Q122: departments as a full model — the register, its members and region / work mode / employment type per employee.',
  routes: ['/api/v1/hr/departments'],
});

feature('hr.people', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The people registry: staff and agents in one list, no table of its own.',
  routes: ['/api/v1/hr/people'],
});
