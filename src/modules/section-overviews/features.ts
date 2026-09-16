import { feature } from '../../shared/features';

/**
 * Features of `section-overviews` — package O-B.
 *
 * One overview read per user section, aggregates only.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('console.section-overviews', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The overview tab of each user section — tiles, series, breakdowns and top tens over a window, with the previous window beside every figure.',
  routes: ['/api/v1/section-overviews'],
});
