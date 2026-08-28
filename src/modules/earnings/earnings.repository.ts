import type { Transaction, TransactionType } from '../../shared/database';

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
  amount: number;
  orderId?: string;
};

export type BalanceTotals = {
  /** Credits only (amount > 0), all time. */
  totalEarnings: number;
  /** Credits minus debits, all time. */
  currentBalance: number;
  /** Credits only, since the first of the current month. */
  thisMonthEarnings: number;
};

export interface EarningsRepository {
  sumBalances(agentId: string, startOfMonth: Date): Promise<BalanceTotals>;
  findTransactions(agentId: string, window: TransactionWindow): Promise<Transaction[]>;
  create(data: NewTransaction): Promise<Transaction>;
}
