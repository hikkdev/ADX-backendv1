import { feature } from '../../shared/features';

/**
 * Features of `wallets` — Lot G (answer 144).
 *
 * The wallet primitives every party shares; `move()` is the one door money
 * goes through. No routes of its own.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('finance.wallet-moves', {
  surfaces: ['BACKEND'],
  owner: 'finance',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'Every credit and debit on every wallet — publisher, agent, advertiser, print partner. Metadata only: the primitives take no flag, and off would mean stopping money, which is a deploy, not a switch.',
});
