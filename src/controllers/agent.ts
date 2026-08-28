import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';

const querySchema = z.object({
  city: z.string().optional(),
  tier: z.string().optional(),
  search: z.string().optional(), // matches against user name or mobile
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export async function getAllAgentsHandler(req: Request, res: Response): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const { city, tier, search, limit, offset } = parsed.data;

  const where = {
    ...(city ? { city } : {}),
    ...(tier ? { tier } : {}),
    ...(search
      ? {
          user: {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { mobile: { contains: search } },
            ],
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.agentProfile.findMany({
      where,
      skip: offset,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, mobile: true, city: true, isActive: true } } },
    }),
    prisma.agentProfile.count({ where }),
  ]);

  res.json({ success: true, data: items, meta: { total, limit, offset } });
}

export async function getAgentByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const agent = await prisma.agentProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, mobile: true, email: true, city: true, isActive: true } } },
  });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  res.json({ success: true, data: agent });
}
