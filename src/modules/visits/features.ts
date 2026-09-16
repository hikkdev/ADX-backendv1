import { feature } from '../../shared/features';

/**
 * Features of `visits` — Lot G (answer 144).
 *
 * Field visits and the agent's day (DR 06; Lot E, Q99).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('agent.field-visits', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Visits dispatched, accepted, scheduled, started and completed; the day view.',
  routes: ['/api/v1/visits', '/api/v1/agents/me/day'],
});
