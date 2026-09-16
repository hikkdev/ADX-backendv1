/**
 * Wallets, for every party on the platform.
 *
 * One table has always served advertisers, publishers and agents; this module
 * is the code that finally does the same. It owns the primitives — open a
 * wallet, read it, move money — and every movement writes the party's statement
 * line and the double-entry legs in a single database transaction, so the books
 * and the wallet cannot disagree.
 *
 * Lot B: the advertiser side moves through here too. `advertisers` still owns
 * the hold-and-capture *decisions* — what a booking may reserve, when it is
 * captured — but the capture itself, the top-up, the package debit, the
 * goodwill credit, the refund and the expiry are all `move()` calls with their
 * counter-legs, so the freeze check and the double-entry twin are one path.
 */
export {
  ensureWallet,
  findWallet,
  findWalletFor,
  snapshot,
  move,
  listEntries,
  sumEntries,
  listWallets,
  freezeWallet,
  unfreezeWallet,
  isWalletFrozen,
} from './wallets.service';

export type { WalletSnapshot } from './wallets.service';
export type { WalletOwner, WalletOwnerKind, MovementInput, WalletListRow } from './wallets.repository';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
