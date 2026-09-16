import { feature } from '../../shared/features';

/**
 * Features of `feature-flags` — Lot G (answer 144).
 *
 * The registry itself (Lot G, answers 144-146).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.feature-flags', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Settings -> Feature flags: every feature across the surfaces, the kill switch, variants, rollback and rollout; the per-caller read the apps boot with.',
  routes: ['/api/v1/flags', '/api/v1/app/flags'],
});
