import { feature } from '../../shared/features';

/**
 * Features of `fraud` — Lot G (answer 144).
 *
 * Fraud as a case object (Lot D, Q54/Q92/Q121; Lot G, Q118: shared signals,
 * the score, escalation).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('safety.fraud-desk', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Fraud cases: notes, evidence, the score and its signals, a decision that applies or lifts suspension scopes.',
  routes: ['/api/v1/fraud'],
  jobs: ['fraud-signal-scan'],
});
