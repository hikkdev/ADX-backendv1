import { feature } from '../../shared/features';

/**
 * Features of `access-control` — Lot G (answer 144).
 *
 * Console roles and what each may do (Lot A).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.roles', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Role configs, their permission lists and their members; the capability matrix the console draws.',
  routes: ['/api/v1/roles-config', '/api/v1/users/:id/role-config'],
});
