import { feature } from '../../shared/features';

/**
 * LT-1 (live agent tracking, 22 Sep 2026): the agent's position while on a
 * job, the ops live map that watches it, and the order timeline across
 * both legs. One key: off, the app sends nothing and the desk's map says
 * the feature is off.
 */
feature('ops.live-map', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Live agent tracking: the agent app reports its position on a job (foreground), Redis holds the live fix, Postgres the trail; the ops live map with states, alerts (idle / late / off-route / offline), trails, ETA and the per-order timeline across the print and install legs.',
  routes: ['/api/v1/agent-locations'],
  jobs: ['agent-trail-retention'],
});
