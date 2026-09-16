import { feature } from '../shared/features';

/**
 * Features owned by bootstrap itself — Lot G (answer 144).
 *
 * The two health routes are mounted here rather than by a module, so the
 * feature that covers them is declared here. Everything else is declared by
 * the module that owns it, in its own `features.ts`.
 */

feature('platform.health', {
  surfaces: ['BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description: 'Liveness and readiness: Postgres and Redis pinged, the failing part named.',
  routes: ['/api/v1/health'],
});
