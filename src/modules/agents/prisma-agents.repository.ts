import { prisma } from '../../shared/database';
import type { AgentFilter, AgentsRepository } from './agents.repository';

export const prismaAgentsRepository: AgentsRepository = {
  async findPage(filter: AgentFilter, limit: number, offset: number) {
    const { city, tier, search } = filter;
    const where = {
      ...(city ? { city } : {}),
      ...(tier ? { tier } : {}),
      // Search spans the joined user, not the agent profile: agents are
      // recognised by the person's name or number, not by profile fields.
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
        include: {
          user: { select: { id: true, name: true, mobile: true, city: true, isActive: true } },
        },
      }),
      prisma.agentProfile.count({ where }),
    ]);
    return { items, total };
  },

  findById(id: string) {
    // The by-id join adds email; the listing does not. Both are contract.
    return prisma.agentProfile.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, mobile: true, email: true, city: true, isActive: true },
        },
      },
    });
  },

  findByUserId(userId: string) {
    return prisma.agentProfile.findUnique({ where: { userId } });
  },
};
