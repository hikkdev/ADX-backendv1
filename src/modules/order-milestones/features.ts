import { feature } from '../../shared/features';

/**
 * Features of `order-milestones` — Lot G (answer 144).
 *
 * The per-order fulfilment checklist: templates, plans and the milestones an
 * agent works through.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('orders.milestones', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'marketplace',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Milestone templates and plans on the console; the agent\'s milestone offers, scheduling, start and completion.',
  routes: [
    '/api/v1/milestone-templates',
    '/api/v1/milestone-plans',
    '/api/v1/orders/:orderId/milestones',
    '/api/v1/agent/milestones',
  ],
});
