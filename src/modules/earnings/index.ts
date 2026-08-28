/**
 * Earnings — an agent's transaction ledger and derived balances.
 *
 * Payout destinations live in `banking`; this module only records what is owed
 * and what has moved.
 */
export { earningsRouter } from './earnings.routes';

/** Used wherever the platform credits or debits an agent. */
export { createTransaction } from './earnings.service';
