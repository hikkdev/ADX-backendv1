import { feature } from '../../shared/features';

/**
 * Features of `advertisers` — Lot G (answer 144).
 *
 * The demand-side account, its brands, its wallet and the desks over the money
 * in it.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('advertisers.accounts', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Advertiser accounts: the party\'s own read, the console directory, eligibility, KYC, activity, agreements, the QR grant to an agent.',
  routes: ['/api/v1/advertisers'],
});

feature('advertisers.brands', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The brands an advertiser books under.',
  routes: ['/api/v1/advertisers/:id/brands'],
});

feature('advertisers.wallet', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The advertiser wallet (Lot B): balance, statement, top-ups, goodwill, holds, refund requests and the finance desks over them.',
  routes: [
    '/api/v1/advertisers/:id/wallet',
    '/api/v1/advertisers/wallet',
    '/api/v1/advertisers/refund-requests',
    '/api/v1/finance/refund-requests',
    '/api/v1/finance/top-ups',
  ],
});

feature('advertisers.funnel', {
  surfaces: ['CONSOLE'],
  owner: 'demand',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The demand-side funnel: advertisers by activation stage.',
  routes: ['/api/v1/advertisers/funnel'],
});
