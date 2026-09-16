import { feature } from '../../shared/features';

/**
 * Features of `announcements` — Lot G (answer 144).
 *
 * A broadcast from ops (Lot E, Q64/Q130).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('comms.announcements', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Announcements drafted, previewed per channel, sent now or at a time, cancelled; the job that fans them out.',
  routes: ['/api/v1/announcements'],
  jobs: ['announcement-sender'],
});
