import { feature } from '../../shared/features';

/**
 * Features of `access-grants` — Lot G (answer 144).
 *
 * The QR grant an agent works under (DR 01/08): what a party allowed, for how
 * long, and the log of it.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('onboarding.agent-assist', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A party grants an agent PROFILE or LISTING access by QR; the grant is live, revocable and logged.',
  routes: ['/api/v1/access-grants'],
});
