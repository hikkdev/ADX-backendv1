/**
 * The ledger — double-entry under every wallet on the platform.
 *
 * `WalletEntry` is unchanged and stays the party's own statement: one row per
 * movement, in the vocabulary the party recognises. This module is the other
 * half, the half a regulator and a reconciliation screen need — every movement
 * balanced against an ADX account, immutable once written, and idempotent on a
 * key the caller derives from whatever caused it.
 *
 * It owns no money of its own. Callers move a wallet and post the matching
 * legs; `verifyLedger` is what proves the two agree, and it runs in the test
 * suite rather than only on request.
 *
 * Nothing here is exposed over HTTP yet. The finance screens that read it —
 * the ledger view, statements, reconciliation — arrive with the payout work.
 */
export {
  PLATFORM_ACCOUNTS,
  ensureAccounts,
  platformAccount,
  walletAccount,
  post,
  reverse,
  assertBalanced,
  balanceOf,
  walletBalance,
  listTransactions,
  getTransaction,
  listAccounts,
  verifyLedger,
  resetAccountCache,
} from './ledger.service';

/**
 * For a caller that must move a wallet and its legs as one act — the wallet
 * update, its statement line and the books, in a single database transaction.
 */
export { postWithin, walletAccountWithin, platformAccountWithin } from './prisma-ledger-tx.repository';
export type { TxClient, PostWithinInput } from './prisma-ledger-tx.repository';

export type { PostInput, PostLeg, PlatformAccountCode } from './ledger.service';
export type { TransactionRow, AccountRow, LegRow } from './ledger.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
