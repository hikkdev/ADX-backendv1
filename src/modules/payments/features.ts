import { feature } from '../../shared/features';

/**
 * Features of `payments` — Lot G (answer 144).
 *
 * Money arriving from advertisers (Lot C): the gateways, the phones' checkout,
 * refunds, and the webhooks.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('payments.gateways', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Payment intents and their status across every gateway; the console\'s payment list and an advertiser\'s payments.',
  routes: ['/api/v1/payments', '/api/v1/advertisers/:id/payments'],
});

feature('payments.razorpay', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Razorpay, live first: the checkout page in the system browser, the return page, the confirm and the webhook.',
  routes: [
    '/api/v1/payments/:id/checkout',
    '/api/v1/payments/:id/return',
    '/api/v1/payments/:id/confirm',
    '/api/v1/webhooks/razorpay',
  ],
});

feature('payments.cashfree', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'dark',
  description:
    'Cashfree in test mode until its credentials arrive (Q110).',
  routes: ['/api/v1/webhooks/cashfree'],
});

feature('payments.ccavenue', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'dark',
  description:
    'CCAvenue in test mode until its credentials arrive (Q110).',
  routes: ['/api/v1/webhooks/ccavenue'],
});

feature('payments.refunds', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A refund to the original method, raised by finance and settled by the gateway.',
  routes: ['/api/v1/payments/:id/refund'],
});
