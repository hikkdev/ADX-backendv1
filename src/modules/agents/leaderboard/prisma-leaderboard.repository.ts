import { prisma } from '../../../shared/database';
import { Decimal } from '../../../shared/money';
import type { LeaderboardRepository } from './leaderboard.repository';

export const prismaLeaderboardRepository: LeaderboardRepository = {
  async cohort(city) {
    const spelling = { equals: city.spelling, mode: 'insensitive' as const };
    const rows = await prisma.agentProfile.findMany({
      where: {
        // Lot X-B: the key is the identity; the spelling catches only the rows whose key is null.
        ...(city.cityId ? { OR: [{ cityId: city.cityId }, { cityId: null, city: spelling }] } : { cityId: null, city: spelling }),
        status: 'ACTIVE',
        user: { isActive: true },
      },
      select: { id: true, userId: true, homeZone: true, territory: true, user: { select: { name: true } } },
    });
    return rows.map((row) => ({
      agentId: row.id,
      userId: row.userId,
      name: row.user.name ?? 'Agent',
      locality: row.homeZone ?? row.territory ?? null,
    }));
  },

  async earningsByAgent(agentIds, window) {
    if (agentIds.length === 0) return new Map();
    const groups = await prisma.agentIncentive.groupBy({
      by: ['agentId'],
      where: {
        agentId: { in: agentIds },
        status: 'CREDITED',
        createdAt: { ...(window.from ? { gte: window.from } : {}), lt: window.to },
      },
      _sum: { amount: true },
    });
    return new Map(groups.map((group) => [group.agentId, new Decimal(group._sum.amount ?? 0)]));
  },
};
