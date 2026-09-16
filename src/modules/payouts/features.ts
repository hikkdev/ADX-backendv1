import { feature } from '../../shared/features';

/**
 * Features of `payouts` — Lot G (answer 144).
 *
 * Money leaving ADX: earnings accrual, withdrawals, payout methods and
 * batches, incentives, limits — and the finance root the desks hang off.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('finance.desk', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The console\'s finance root: every desk under /finance not claimed by a narrower feature (rails, limits, tax rates).',
  routes: [
    '/api/v1/finance',
    '/api/v1/finance/limits',
    '/api/v1/finance/tax-rates',
    '/api/v1/finance/rails',
  ],
});

feature('finance.wallets', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The console\'s read over every wallet and its entries.',
  routes: ['/api/v1/finance/wallets'],
});

feature('payouts.wallet', {
  surfaces: ['APP_USER', 'APP_AGENT'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A publisher\'s or agent\'s wallet on the phone: balance, entries, earnings, incentives.',
  routes: ['/api/v1/payouts', '/api/v1/payouts/wallet'],
});

feature('payouts.withdrawals', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Withdrawal requests: raised and cancelled on the phone, approved / rejected / marked paid / failed by finance, raised on a partner\'s behalf.',
  routes: ['/api/v1/payouts/withdrawals', '/api/v1/finance/withdrawals'],
});

feature('payouts.methods', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Payout methods and the IFSC lookup; verified or rejected by finance; ADX\'s own bank accounts.',
  routes: [
    '/api/v1/payouts/methods',
    '/api/v1/payouts/ifsc',
    '/api/v1/finance/payout-methods',
    '/api/v1/finance/bank-accounts',
  ],
});

feature('payouts.batches', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot B (Q85/Q140): payout batches — drafted, submitted, approved (reserves), released (debits), exported, line by line.',
  routes: ['/api/v1/finance/payout-batches'],
  jobs: ['payout-batch-draft'],
});

feature('payouts.incentives', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Agent incentives and the rates behind them; credited or rejected by finance.',
  routes: ['/api/v1/finance/incentives', '/api/v1/finance/incentive-rates'],
});

feature('payouts.earnings-accrual', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot B (B1): every live spot accrues daily — gross = rate × quantity, commission from the stamp; the run and the quantity backfill.',
  routes: ['/api/v1/finance/accrual', '/api/v1/finance/accruals'],
  jobs: ['earnings-accrual'],
});
