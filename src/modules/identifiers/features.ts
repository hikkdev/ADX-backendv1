import { feature } from '../../shared/features';

/**
 * Features of `identifiers` — Lot G (answer 144).
 *
 * Display identifiers (PUB-1009-2601 and friends): the formats and the
 * counters.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.identifiers', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Identifier formats per party, the preview, and the backfill (publishers, and QR-4: people — the ADX-… id every account is minted with).',
  routes: ['/api/v1/identifiers'],
});
