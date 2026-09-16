import type { Prisma } from '../../shared/database';
import type {
  LedgerTransactionKind,
  Wallet,
  WalletEntry,
  WalletEntryType,
} from '../../shared/database';
import type { Money } from '../../shared/money';

/**
 * Wallets, for every party.
 *
 * The advertiser side keeps its own hold-and-capture path in the advertisers
 * module — that machinery is about a booking and belongs with bookings. This
 * owns the primitives every party shares: opening a wallet, reading it, and
 * moving money in a way that writes the statement line and the ledger legs
 * together.
 */

/**
 * The four owners a wallet admits — the table's CHECK says exactly one.
 * PRINT_PARTNER is Lot B (Q50/B4b): a print partner is a payee, so its
 * approved job costs land here and leave through the same withdrawal ladder.
 */
export type WalletOwnerKind = 'PUBLISHER' | 'AGENT' | 'ADVERTISER' | 'PRINT_PARTNER';
export type WalletOwner = { kind: WalletOwnerKind; id: string };

export type WalletSnapshotRow = {
  wallet: Wallet;
  held: Prisma.Decimal;
  openWithdrawals: Prisma.Decimal;
  /** Credited, inside its clearing window, and not yet withdrawable. */
  pendingClearance: Prisma.Decimal;
};

export type MovementInput = {
  walletId: string;
  /** Names the ledger account if it has to be opened. */
  walletLabel: string;
  /** Signed: positive credits the party, negative debits them. */
  amount: Money;
  entryType: WalletEntryType;
  ledgerKind: LedgerTransactionKind;
  /**
   * Derived from what caused the movement, never from a clock. This is what
   * makes a retried job, a replayed webhook and a double tap one movement.
   */
  idempotencyKey: string;
  /** The other side of the book. Must sum with the wallet leg to zero. */
  counterLegs: { accountCode: string; amount: Money; note?: string | null }[];
  isGoodwill?: boolean;
  /**
   * Lot B: a debit that spends goodwill before settled balance — the
   * advertiser rule. Goodwill exists only to be spent on a booking and can
   * never be withdrawn, so taking real money while leaving it behind would
   * quietly strand it. Writes up to two statement lines (the goodwill part
   * flagged `isGoodwill`) under one ledger transaction.
   */
  spendGoodwillFirst?: boolean;
  /**
   * Lot B: settle this hold in the same transaction — CAPTURED, with the
   * balance entry carrying `holdId`. Refused 409 when the hold is not HELD.
   */
  captureHoldId?: string | null;
  /**
   * Lot B: refuse 402 INSUFFICIENT_FUNDS inside the transaction when the
   * wallet's spendable balance (balance + goodwill − open holds) does not
   * cover a debit. Read and spent in one act, so two concurrent debits cannot
   * both see the same money.
   */
  requireFunds?: boolean;
  /**
   * Lot A (Q21): the one debit a frozen wallet admits — the final payout a
   * closure raised, whose freeze is the closure's own doing. Nothing else
   * sets this.
   */
  allowFrozen?: boolean;
  campaignId?: string | null;
  orderId?: string | null;
  reference?: string | null;
  note?: string | null;
  occurredAt?: Date;
  createdByUserId?: string | null;
};

export type MovementResult = {
  wallet: Wallet;
  /** The settled-balance line, or the only line. */
  entry: WalletEntry | null;
  /** Every statement line the movement wrote — two when goodwill was spent first. */
  entries: WalletEntry[];
  ledgerTransactionId: string;
  created: boolean;
} | null;

export type WalletListRow = Wallet & {
  publisher: { id: string; name: string; displayId: string | null; sizeBand: string } | null;
  agent: { id: string; userId: string } | null;
  advertiser: { id: string; name: string; companyName: string | null } | null;
  /** Lot B (B4b): the fourth owner. */
  printPartner: { id: string; name: string; displayId: string | null; city: string | null } | null;
};

export interface WalletsRepository {
  ensure(owner: WalletOwner, label: string): Promise<Wallet>;
  findById(walletId: string): Promise<Wallet | null>;
  findByOwner(owner: WalletOwner): Promise<Wallet | null>;
  snapshot(walletId: string, now: Date): Promise<WalletSnapshotRow | null>;
  listEntries(
    walletId: string,
    filter: {
      types?: WalletEntryType[];
      from?: Date;
      to?: Date;
      limit: number;
      cursor?: string;
    }
  ): Promise<WalletEntry[]>;
  /**
   * Wallet, statement line and ledger legs, in one database transaction.
   *
   * The freeze check lives INSIDE that transaction (Lot A verifier finding):
   * a debit reads `frozenAt` on the row it is about to update, so a freeze
   * landing between a service-level read and the write still refuses it.
   */
  move(input: MovementInput): Promise<MovementResult>;
  sumEntries(
    walletId: string,
    types?: WalletEntryType[],
    from?: Date,
    to?: Date
  ): Promise<{ total: Prisma.Decimal; count: number }>;
  listWallets(filter: {
    kind?: WalletOwnerKind;
    limit: number;
  }): Promise<WalletListRow[]>;
  /**
   * Lot A FREEZE_WALLET. Frozen means money may land but may not leave; the
   * CHECK on the table requires a reason whenever `frozenAt` is set.
   */
  freeze(walletId: string, input: { reason: string; byUserId: string | null; at: Date }): Promise<Wallet | null>;
  unfreeze(walletId: string): Promise<Wallet | null>;
}
