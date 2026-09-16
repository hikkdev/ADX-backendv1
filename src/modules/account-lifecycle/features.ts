import { feature } from '../../shared/features';

/**
 * Features of `account-lifecycle` — Lot G (answer 144).
 *
 * Leaving ADX: a closure a person asks for and ops decide, and an erasure the
 * DPO approves and executes (Lot A, Q21/Q60).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('account.closure', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A party asks to close their account; ops review the case and decide.',
  routes: [
    '/api/v1/users/me/closure-request',
    '/api/v1/users/closure-cases',
    '/api/v1/users/:id/closure-review',
    '/api/v1/users/:id/closure-cases',
  ],
});

feature('account.erasure', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A person asks to be erased; the DPO approves, refuses or executes, and the number is tombstoned.',
  routes: [
    '/api/v1/users/me/erasure',
    '/api/v1/users/erasure',
    '/api/v1/users/:id/erasure',
  ],
});

feature('users.data-export', {
  surfaces: ['APP_USER', 'CONSOLE', 'BACKEND'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "Q125: a person's data exported on request (DataExportRequest) — built by the job, released as a time-limited file.",
  jobs: ['data-export'],
});
