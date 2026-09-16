import { Prisma, prisma } from '../../shared/database';
import { money } from '../../shared/money';
import type { TransactionType, WalletEntry, WalletEntryType } from '../../shared/database';
import type {
  BalanceTotals,
  EarningEntry,
  EarningsRepository,
  NewTransaction,
  TransactionWindow,
} from './earnings.repository';

/**
 * An agent's ledger, stored in the shared wallet.
 *
 * This used to read and write the agent-only `Transaction` table. That table
 * still exists and still holds the rows it always did — it is simply no longer
 * read, so its numbers stay available to reconcile against until someone has
 * checked them and dropped it deliberately.
 *
 * The two vocabularies are mapped here and nowhere else, so the module's
 * public shape did not change when the storage underneath it did.
 */

const D = Prisma.Decimal;

/** Wallet vocabulary in; transaction vocabulary out. Exported for the test that
 *  pins the round trip — that is what keeps the endpoint's contract intact. */
export const TO_ENTRY: Record<TransactionType, WalletEntryType> = {
  ORDER_COMPLETION: 'EARNING',
  BONUS: 'BONUS',
  REFERRAL: 'REFERRAL',
  PAYOUT: 'PAYOUT',
  ADJUSTMENT: 'ADJUSTMENT',
};

const TO_TRANSACTION: Partial<Record<WalletEntryType, TransactionType>> = {
  EARNING: 'ORDER_COMPLETION',
  BONUS: 'BONUS',
  REFERRAL: 'REFERRAL',
  PAYOUT: 'PAYOUT',
  ADJUSTMENT: 'ADJUSTMENT',
};

/**
 * Demand-side entry types have no transaction equivalent and should never
 * appear on an agent wallet. Reporting them as ADJUSTMENT keeps the endpoint
 * describable rather than throwing at read time if one ever does.
 */
export const asTransactionType = (type: WalletEntryType): TransactionType =>
  TO_TRANSACTION[type] ?? 'ADJUSTMENT';

/** Exported for the test that pins the money conversion. */
export const toEarning = (entry: WalletEntry, agentId: string): EarningEntry => ({
  id: entry.id,
  agentId,
  type: asTransactionType(entry.type),
  title: entry.note ?? '',
  // Two decimal places, always, straight off the Decimal column — never through
  // a JS number, which is what this conversion used to do.
  amount: money(entry.amount),
  orderId: entry.orderId,
  // Never stored: an entry only exists once the money has moved. The field is
  // kept because the agent app reads it.
  status: 'COMPLETED',
  createdAt: entry.createdAt,
});

const walletFor = (agentId: string) => prisma.wallet.findUnique({ where: { agentId } });

export const prismaEarningsRepository: EarningsRepository = {
  async sumBalances(agentId: string, startOfMonth: Date): Promise<BalanceTotals> {
    const wallet = await walletFor(agentId);
    // An agent with no wallet has earned nothing; that is not an error, and
    // zero is still money, so it is formatted like every other amount.
    if (!wallet) {
      return { totalEarnings: money(0), currentBalance: money(0), thisMonthEarnings: money(0) };
    }

    // Three aggregates rather than one: earnings count credits only, while the
    // balance nets debits against them.
    const [totalEarningsAgg, thisMonthAgg] = await Promise.all([
      prisma.walletEntry.aggregate({
        where: { walletId: wallet.id, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      prisma.walletEntry.aggregate({
        where: { walletId: wallet.id, amount: { gt: 0 }, createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalEarnings: money(totalEarningsAgg._sum.amount ?? 0),
      // Read off the wallet rather than re-summed: the balance column is the
      // one the money moves through, so a disagreement here would be a bug
      // hidden by recomputing around it.
      currentBalance: money(wallet.balance),
      thisMonthEarnings: money(thisMonthAgg._sum.amount ?? 0),
    };
  },

  async findTransactions(agentId: string, window: TransactionWindow): Promise<EarningEntry[]> {
    const wallet = await walletFor(agentId);
    if (!wallet) return [];

    const { limit = 50, offset = 0, startDate, endDate } = window;
    const rows = await prisma.walletEntry.findMany({
      where: {
        walletId: wallet.id,
        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate ? { gte: startDate } : {}),
                ...(endDate ? { lte: endDate } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return rows.map((row) => toEarning(row, agentId));
  },

  /**
   * Credits or debits an agent in one transaction: the wallet moves and the
   * entry that explains it is written together, or neither happens.
   */
  async create(data: NewTransaction): Promise<EarningEntry> {
    const amount = new D(data.amount);

    return prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { agentId: data.agentId },
        create: { agentId: data.agentId, balance: amount },
        update: { balance: { increment: amount } },
      });

      const entry = await tx.walletEntry.create({
        data: {
          walletId: wallet.id,
          type: TO_ENTRY[data.type],
          amount,
          balanceAfter: wallet.balance,
          note: data.title,
          orderId: data.orderId ?? null,
        },
      });

      return toEarning(entry, data.agentId);
    });
  },
};
