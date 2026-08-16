import { prisma } from '../lib/prisma';
import type { TransactionType } from '../generated/prisma';

export async function getBalance(agentId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
    currency: 'INR',
  };
}

export async function getTransactions(
  agentId: string,
  opts: { limit?: number; offset?: number; startDate?: Date; endDate?: Date } = {},
) {
  const { limit = 50, offset = 0, startDate, endDate } = opts;
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
}

export async function createTransaction(data: {
  agentId: string;
  type: TransactionType;
  title: string;
  amount: number;
  orderId?: string;
}) {
  return prisma.transaction.create({ data });
}
