import { feature } from '../../shared/features';

/**
 * Features of `earnings` — Lot G (answer 144).
 *
 * The agent's earnings read (the money itself moves in wallets / payouts).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('agent.earnings', {
  surfaces: ['APP_AGENT'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The agent\'s balance and transaction list on the phone.',
  routes: ['/api/v1/earnings'],
});
