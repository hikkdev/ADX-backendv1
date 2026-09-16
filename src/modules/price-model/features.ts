import { feature } from '../../shared/features';

/**
 * Features of `price-model` — Lot G (answer 144).
 *
 * The rule-based price model and the quotes it prices.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('pricing.price-model', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Model settings, dimensions and their values, category rules, rules and their conditions, the simulator.',
  routes: ['/api/v1/price-model'],
});

feature('pricing.quotes', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Quotes priced by the model and moved through their statuses.',
  routes: ['/api/v1/price-model/quotes'],
});
