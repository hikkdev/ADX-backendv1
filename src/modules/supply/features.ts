import { feature } from '../../shared/features';

/**
 * Features of `supply` — Lot G (answer 144).
 *
 * How a listing gets verified, documented, claimed and policed.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('supply.listing-attempts', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'An agent\'s on-site listing attempt, the acceptances it collects, and the supply root.',
  routes: [
    '/api/v1/supply',
    '/api/v1/supply/attempts',
    '/api/v1/supply/agreements',
  ],
});

feature('supply.verification', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Listing documents and site verifications, reviewed from the verification queue.',
  routes: [
    '/api/v1/supply/listings',
    '/api/v1/supply/documents',
    '/api/v1/supply/verifications',
    '/api/v1/supply/verification-queue',
  ],
});

feature('supply.claims', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Ownership claims on a listing, decided by ops.',
  routes: ['/api/v1/supply/claims'],
});

feature('supply.compliance', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Compliance cases, the enforcement sweep and the earnings holds it raises.',
  routes: ['/api/v1/supply/compliance', '/api/v1/supply/enforcement'],
});

feature('supply.funnel', {
  surfaces: ['CONSOLE'],
  owner: 'supply',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The supply-side funnel: publishers by stage.',
  routes: ['/api/v1/supply/funnel'],
});
