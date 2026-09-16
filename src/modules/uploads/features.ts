import { feature } from '../../shared/features';

/**
 * Features of `uploads` — Lot G (answer 144).
 *
 * Files in and files out (Lot D, Q61).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('platform.uploads', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Uploading a file and reading a private one back through the one door.',
  routes: ['/api/v1/upload', '/api/v1/files'],
});
