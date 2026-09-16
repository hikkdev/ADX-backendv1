import { feature } from '../../shared/features';

/**
 * Features of `ai` — Lot G (answer 144).
 *
 * The AI seams a phone calls directly.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('ai.listing-description', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A drafted listing description and the quota behind it.',
  routes: ['/api/v1/ai'],
});
