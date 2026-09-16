import type { Prisma } from '../../shared/database';
import type {
  LedgerAccount,
  LedgerAccountKind,
  LedgerLeg,
  LedgerTransaction,
  LedgerTransactionKind,
} from '../../shared/database';

/**
 * What the ledger needs from storage.
 *
 * Deliberately missing an update and a delete. The database refuses both with a
 * trigger; leaving them off the port as well means nothing in the codebase can
 * even reach for one, and a reviewer never has to check whether a caller was
 * careful.
 */

export type AccountRow = LedgerAccount;
export type LegRow = LedgerLeg;
export type TransactionRow = LedgerTransaction & { legs: (LegRow & { account: AccountRow })[] };

export type NewLeg = {
  accountId: string;
  amount: Prisma.Decimal;
  campaignId?: string | null;
  orderId?: string | null;
  reference?: string | null;
  note?: string | null;
};

export type NewTransaction = {
  reference: string;
  kind: LedgerTransactionKind;
  idempotencyKey: string;
  reversesId?: string | null;
  occurredAt: Date;
  createdByUserId?: string | null;
  note?: string | null;
  legs: NewLeg[];
};

export type TransactionFilter = {
  accountId?: string;
  walletId?: string;
  kind?: LedgerTransactionKind[];
  from?: Date;
  to?: Date;
  /** E6: a transaction with a leg of exactly this absolute amount (decimal string). */
  amount?: string;
  limit: number;
  cursor?: string;
};

export interface LedgerRepository {
  /** Platform accounts are seeded from a fixed chart; wallets get one each. */
  findAccountByCode(code: string): Promise<AccountRow | null>;
  findAccountByWallet(walletId: string): Promise<AccountRow | null>;
  createAccount(data: {
    code: string;
    name: string;
    kind: LedgerAccountKind;
    walletId?: string | null;
  }): Promise<AccountRow>;
  listAccounts(kind?: LedgerAccountKind): Promise<AccountRow[]>;

  /**
   * Appends one balanced transaction and its legs in a single database
   * transaction. Returns the existing one when the idempotency key has been
   * seen, rather than raising — a retry is not an error.
   */
  append(data: NewTransaction): Promise<{ transaction: TransactionRow; created: boolean }>;

  findTransaction(id: string): Promise<TransactionRow | null>;
  findTransactionByKey(idempotencyKey: string): Promise<TransactionRow | null>;
  listTransactions(filter: TransactionFilter): Promise<TransactionRow[]>;
  referenceExists(reference: string): Promise<boolean>;
  /** The next sequence number for a year, used to mint a readable reference. */
  countForYear(year: number): Promise<number>;

  /** Sum of an account's legs. The account's balance, derived rather than stored. */
  balanceOf(accountId: string): Promise<Prisma.Decimal>;

  /**
   * Transactions whose legs do not sum to zero.
   *
   * Should always be empty — a deferred constraint trigger makes an unbalanced
   * transaction impossible to commit. It exists so an operator can prove that
   * rather than trust it, and so the proof runs in the test suite.
   */
  findUnbalanced(): Promise<{ transactionId: string; total: Prisma.Decimal }[]>;

  /** Every wallet whose stored balance disagrees with its ledger account. */
  findWalletDrift(): Promise<
    { walletId: string; walletTotal: Prisma.Decimal; ledgerTotal: Prisma.Decimal }[]
  >;
}
