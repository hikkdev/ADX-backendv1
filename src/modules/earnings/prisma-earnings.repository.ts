import { prisma } from '../../shared/database';
import type {
  EarningsRepository,
  NewTransaction,
  TransactionWindow,
} from './earnings.repository';

export const prismaEarningsRepository: EarningsRepository = {
  async sumBalances(agentId: string, startOfMonth: Date) {
    // Three aggregates rather than one: earnings count credits only, while the
    // balance nets debits against them.
    const [totalEarningsAgg, balanceAgg, thisMonthAgg] = await Promise.all([
      prisma.transaction.aggregate({
        where: { agentId, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { agentId },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { agentId, amount: { gt: 0 }, createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalEarnings: totalEarningsAgg._sum.amount ?? 0,
      currentBalance: balanceAgg._sum.amount ?? 0,
      thisMonthEarnings: thisMonthAgg._sum.amount ?? 0,
    };
  },

  findTransactions(agentId: string, window: TransactionWindow) {
    const { limit = 50, offset = 0, startDate, endDate } = window;
    return prisma.transaction.findMany({
      where: {
        agentId,
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
  },

  create(data: NewTransaction) {
    return prisma.transaction.create({ data });
  },
};
