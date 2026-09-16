import { feature } from '../../shared/features';

/**
 * Features of `legal` — Lot G (answer 144).
 *
 * The read documents (terms, privacy) — the two public reads carry no token.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('legal.documents', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Legal documents: read by kind without a token, managed and activated by ops.',
  routes: ['/api/v1/legal'],
});
