import { feature } from '../../shared/features';

/**
 * Features of `disputes` — Lot G (answer 144).
 *
 * Disputes between the parties, with a paused SLA clock (Lot D).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('support.disputes', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Disputes: raised, messaged, evidenced, resolved, reopened, rated; the credit release.',
  routes: ['/api/v1/disputes'],
});
