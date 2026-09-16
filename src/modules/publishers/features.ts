import { feature } from '../../shared/features';

/**
 * Features of `publishers` — Lot G (answer 144).
 *
 * The supply-side party: onboarding by an agent's QR claim or on their own,
 * the dashboard, the KYC desk, the legacy-book import.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('publisher.onboarding', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Publisher accounts: register, the party\'s own read and edit, the QR grant to an agent, onboarding completion or cancellation, the console directory.',
  routes: ['/api/v1/publishers'],
});

feature('publisher.dashboard', {
  surfaces: ['APP_USER'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The publisher\'s home: dashboard figures and their listings.',
  routes: ['/api/v1/publishers/me/dashboard', '/api/v1/publishers/me/listings'],
});

feature('publisher.kyc-desk', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Publisher KYC: submitted by the party, reviewed per document from the queue, re-uploads asked, assignment as a filter.',
  routes: [
    '/api/v1/publishers/kyc-queue',
    '/api/v1/publishers/:publisherId/kyc',
    '/api/v1/publishers/me/kyc',
  ],
});

feature('publisher.legacy-import', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot D (Q86): the legacy-book import with its per-row report, commit and revoke.',
  routes: ['/api/v1/publishers/import', '/api/v1/publishers/imports'],
});

feature('publisher.book', {
  surfaces: ['APP_AGENT'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The agent\'s publisher book.',
  routes: ['/api/v1/publishers/book'],
});
