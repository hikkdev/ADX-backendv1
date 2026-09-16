import { feature } from '../../shared/features';

/**
 * Features of `onboarding` — Lot G (answer 144).
 *
 * The back-office intake form and the flow templates behind it.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('onboarding.submissions', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Onboarding submissions for every user type; an APPROVED one provisions the profile.',
  routes: ['/api/v1/onboarding'],
});

feature('onboarding.flow-templates', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The flow templates the intake form runs on.',
  routes: ['/api/v1/onboarding/flow-templates'],
});
