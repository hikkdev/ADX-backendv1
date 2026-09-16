import { feature } from '../../shared/features';

/**
 * Features of `safety` — Lot G (answer 144).
 *
 * A blocking report takes the job off the agent.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('safety.alerts', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Safety alerts raised by an agent and worked by ops.',
  routes: ['/api/v1/safety'],
});
