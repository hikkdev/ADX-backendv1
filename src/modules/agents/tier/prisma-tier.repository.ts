import { prisma } from '../../../shared/database';
import type { NewTierEvent, TierRepository } from './tier.repository';

const profileSelect = { id: true, userId: true, city: true, tier: true, tierLevel: true, tierPinnedAt: true } as const;

export const prismaTierRepository: TierRepository = {
  findProfile(agentId) {
    return prisma.agentProfile.findUnique({ where: { id: agentId }, select: profileSelect });
  },

  findProfileByUser(userId) {
    return prisma.agentProfile.findUnique({ where: { userId }, select: profileSelect });
  },

  async writeRung(agentId, tier, level, pinnedAt) {
    await prisma.agentProfile.update({ where: { id: agentId }, data: { tier, tierLevel: level, tierPinnedAt: pinnedAt } });
  },

  createEvent(data: NewTierEvent) {
    return prisma.agentTierEvent.create({ data: { ...data, byUserId: data.byUserId ?? null } });
  },

  findUnacknowledged(agentId) {
    return prisma.agentTierEvent.findFirst({
      where: { agentId, acknowledgedAt: null },
      orderBy: { at: 'desc' },
    });
  },

  findEvent(eventId) {
    return prisma.agentTierEvent.findUnique({ where: { id: eventId } });
  },

  acknowledge(eventId, at) {
    return prisma.agentTierEvent.update({ where: { id: eventId }, data: { acknowledgedAt: at } });
  },

  listEvents(agentId, limit) {
    return prisma.agentTierEvent.findMany({ where: { agentId }, orderBy: { at: 'desc' }, take: limit });
  },
};
