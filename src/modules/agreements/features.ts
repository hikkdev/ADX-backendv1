import { feature } from '../../shared/features';

/**
 * Features of `agreements` — Lot G (answer 144).
 *
 * The words every party accepts, and who accepted which version (Lot D,
 * Q55/Q123).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('legal.agreements', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Agreement templates (draft / live / superseded), acceptances per party and per transaction, the stale-terms report.',
  routes: ['/api/v1/agreements', '/api/v1/advertisers/:id/agreements'],
});

/**
 * DS-1 (Digio eSign, 22 Sep 2026): e-signatures on the five documents. Its
 * own key so the rail can be switched off as a feature beside the policy
 * switch in platform settings; the webhook is the provider's, not a user's.
 */
feature('legal.esign', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Digio eSign on the five documents: the Signatures desk, the parties\' signing doors, the gates that wait on a signature, the e-stamp and ADX countersign.',
  routes: ['/api/v1/agreements/signing', '/api/v1/webhooks/digio/esign'],
  jobs: ['esign-expiry'],
});
