/**
 * Earnings — an agent's ledger and the balances derived from it.
 *
 * Payout destinations live in `banking`; this module only records what is owed
 * and what has moved.
 *
 * The ledger is the shared `Wallet`, not the agent-only `Transaction` table it
 * used to be. The endpoints' shapes are unchanged: the two vocabularies are
 * mapped inside the Prisma adapter so callers cannot tell the difference.
 */
export { earningsRouter } from './earnings.routes';

/** Used wherever the platform credits or debits an agent. */
export { createTransaction } from './earnings.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
