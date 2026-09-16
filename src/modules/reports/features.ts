import { feature } from '../../shared/features';

/**
 * Features of `reports` — Lot G (answer 144), declared by G9 while G8 was
 * building the module: the recurring-report subsystem (Q129/Q143).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net. G8: import
 * this file from `index.ts` (`import './features';`) so the declaration
 * loads at boot, and split the key when the schedules and the runs deserve
 * their own switches.
 */

feature('reports.catalogue', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot G (Q129/Q143): the twelve reports defined in code — run on demand or on a schedule, mailed as a time-limited link.',
  routes: ['/api/v1/reports'],
  jobs: ['report-schedule'],
});
