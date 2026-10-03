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

feature('safety.order-screening', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Order fraud screening: every order scored and explained signal by signal, flagged for review, held (reversibly) by a person or — when switched on — automatically; cleared, or cancelled as fraud by a person; the nightly re-screen of open orders.',
  routes: [
    '/api/v1/orders/fraud-review',
    '/api/v1/orders/:id/hold',
    '/api/v1/orders/:id/release',
    '/api/v1/orders/:id/clear',
    '/api/v1/orders/:id/confirm-fraud',
    '/api/v1/orders/:id/cancel-impact',
    '/api/v1/orders/:id/fraud-case',
    '/api/v1/orders/:id/rescore',
  ],
  jobs: ['order-risk-rescreen'],
});
