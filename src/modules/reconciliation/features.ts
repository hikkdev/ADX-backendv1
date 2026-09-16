import { feature } from '../../shared/features';

/**
 * Features of `reconciliation` — Lot G (answer 144).
 *
 * The books against the bank (Lot B, Q85).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('finance.reconciliation', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Bank statement profiles, imports, lines, auto-match and the manual matches.',
  routes: ['/api/v1/finance/reconciliation'],
});
