import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { requireAgentProfile } from '../agents';
import { transactionsQuerySchema } from './earnings.schema';
import { getBalance, getTransactions } from './earnings.service';

export async function getBalanceHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const balance = await getBalance(agent.id);
  res.json({ success: true, data: balance });
}

export async function getTransactionsHandler(req: Request, res: Response): Promise<void> {
  // The agent profile is resolved before the query is validated, so a caller
  // without one gets 404 even when the query is also malformed. Original order.
  const agent = await requireAgentProfile(req.user!.sub);

  const parsed = transactionsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const { limit, offset, startDate, endDate } = parsed.data;
  const transactions = await getTransactions(agent.id, {
    limit,
    offset,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
  });

  res.json({ success: true, data: transactions });
}
