import { feature } from '../../shared/features';

/**
 * Features of `integrations` — Lot G (answer 144).
 *
 * Third-party credentials and routing (a different AppConfig row).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.integrations', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The integrations row: SMS rails, email, HRMS, work tool, KYC provider mode, maps — secrets masked on the way out.',
  routes: ['/api/v1/integrations'],
});
