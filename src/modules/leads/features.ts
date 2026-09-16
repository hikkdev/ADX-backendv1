import { feature } from '../../shared/features';

/**
 * Features of `leads` — Lot G (answer 144).
 *
 * The agent's prospects (DR 06; Lot D, Q93).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('agent.leads', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Leads near the agent, contact / visit / convert, the transactional import.',
  routes: ['/api/v1/leads'],
});
