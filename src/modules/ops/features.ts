import { feature } from '../../shared/features';

/**
 * Features of `ops` — Lot G (answer 144).
 *
 * The on-call read and the housekeeping jobs (Lot E, decisions 95/126).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.health', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'System health: last dump, last drill, retention-due, job heartbeats; the restore drill and the retention sweep.',
  routes: ['/api/v1/settings/system-health'],
  jobs: ['restore-drill', 'retention', 'health-sample'],
});

feature('system.status-page', {
  surfaces: ['WEBSITE', 'CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot G (Q130): the public status page — samples every five minutes, the incident log, regions, and the subscribe / confirm / unsubscribe links.',
  routes: ['/status'],
});
