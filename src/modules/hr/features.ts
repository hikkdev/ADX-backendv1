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
    'The year\'s holidays, editable by ops; the schedule reads them. HC-1 (1 Oct 2026): kept in step with a public holiday calendar (Google\'s Holidays in India by default, Settings › Integrations) — weekly, at boot when next year is empty, and on "Sync now"; a person\'s own entry always wins.',
  routes: ['/api/v1/hr/holidays'],
  jobs: ['holiday-calendar'],
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
