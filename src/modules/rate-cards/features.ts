import { feature } from '../../shared/features';

/**
 * Features of `rate-cards` — Lot G (answer 144).
 *
 * Rate-card governance beside the pricing engine (Lot E, Q97; E10-2).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('pricing.rate-cards', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Rate cards: draft, entries, submit, approve, reject, archive, revise; the impact read and the dry run over a draft grid.',
  routes: ['/api/v1/rate-cards'],
});

feature('pricing.price-approvals', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Price approval cases (PUBLISH_REQUEST / CARD_REVISION) and the gate a listing passes before it publishes.',
  routes: ['/api/v1/rate-cards/approvals', '/api/v1/rate-cards/gate'],
});
