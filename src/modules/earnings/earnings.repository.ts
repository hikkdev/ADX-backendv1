import type { Money } from '../../shared/money';
import type { TransactionType } from '../../shared/database';

export type TransactionWindow = {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
};

export type NewTransaction = {
  agentId: string;
  type: TransactionType;
  title: string;
  /** Signed: positive credits the agent, negative debits them. */
  amount: Money;
  orderId?: string;
};

/**
 * The shape `GET /earnings/transactions` returns.
 *
 * Storage moved from the agent-only `Transaction` table to the shared wallet
 * without disturbing this: same fields, same `TransactionType` vocabulary. The
 * mapping between the two lives in the Prisma adapter and nowhere else.
 *
 * `amount` is a decimal string rather than a number, as every other money field
 * on this API is. The column is `Decimal(14,2)`, and putting it through a binary
 * float to reach the client is how a balance becomes 1249.9999999999998 — the
 * same reason `ratePerDay` is a string. It was a number here because this module
 * predates that rule, not because a ledger needs one less.
 */
export type EarningEntry = {
  id: string;
  agentId: string;
  type: TransactionType;
  title: string;
  /** Signed: credits positive, payouts negative. */
  amount: Money;
  orderId: string | null;
  status: string;
  createdAt: Date;
};

export type BalanceTotals = {
  /** Credits only (amount > 0), all time. */
  totalEarnings: Money;
  /** Credits minus debits, all time. */
  currentBalance: Money;
  /** Credits only, since the first of the current month. */
  thisMonthEarnings: Money;
};

export interface EarningsRepository {
  sumBalances(agentId: string, startOfMonth: Date): Promise<BalanceTotals>;
  findTransactions(agentId: string, window: TransactionWindow): Promise<EarningEntry[]>;
  create(data: NewTransaction): Promise<EarningEntry>;
}
