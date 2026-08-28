import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';
import { getBalance, getTransactions } from '../services/earnings.service';

export async function getBalanceHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const balance = await getBalance(agent.id);
  res.json({ success: true, data: balance });
}

export async function getTransactionsHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const parsed = z.object({
    limit: z.coerce.number().default(50),
    offset: z.coerce.number().default(0),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }).safeParse(req.query);

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
