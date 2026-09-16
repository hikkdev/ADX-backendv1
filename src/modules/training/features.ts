import { feature } from '../../shared/features';

/**
 * Features of `training` — Lot G (answer 144).
 *
 * The training library, the modules, the quiz and the certification (DR 05).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('agent.training', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Training resources, modules, progress and the quiz.',
  routes: ['/api/v1/training'],
});

feature('agent.certification', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Certification earned by the curriculum, listed and revoked by ops.',
  routes: ['/api/v1/training/certification', '/api/v1/training/certifications'],
});
