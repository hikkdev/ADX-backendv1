import { prismaEarningsRepository as repository } from './prisma-earnings.repository';
import type { NewTransaction, TransactionWindow } from './earnings.repository';

export async function getBalance(agentId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const totals = await repository.sumBalances(agentId, startOfMonth);

  // Currency is fixed at INR — there is no multi-currency support, and the
  // field exists so clients do not have to assume one.
  return { ...totals, currency: 'INR' };
}

export async function getTransactions(agentId: string, window: TransactionWindow = {}) {
  return repository.findTransactions(agentId, window);
}

export async function createTransaction(data: NewTransaction) {
  return repository.create(data);
}
