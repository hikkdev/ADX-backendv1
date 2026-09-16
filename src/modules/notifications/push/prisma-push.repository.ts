import { prisma } from '../../../shared/database';
import type { PushRepository, RegisterDeviceInput } from './push.repository';

export const prismaPushRepository: PushRepository = {
  async register(input: RegisterDeviceInput, now: Date) {
    const existing = await prisma.deviceToken.findUnique({ where: { token: input.token } });
    const data = {
      userId: input.userId,
      app: input.app,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      lastSeenAt: now,
    };
    if (!existing) {
      const row = await prisma.deviceToken.create({ data: { token: input.token, ...data } });
      return { row, created: true, movedFromUserId: null };
    }
    const row = await prisma.deviceToken.update({ where: { token: input.token }, data });
    return { row, created: false, movedFromUserId: existing.userId === input.userId ? null : existing.userId };
  },

  async remove(userId: string, token: string) {
    const result = await prisma.deviceToken.deleteMany({ where: { userId, token } });
    return result.count > 0;
  },

  async removeByToken(token: string) {
    const result = await prisma.deviceToken.deleteMany({ where: { token } });
    return result.count > 0;
  },

  listForUser(userId: string) {
    return prisma.deviceToken.findMany({ where: { userId }, orderBy: { lastSeenAt: 'desc' } });
  },

  listAll(afterId: string | null, take: number) {
    return prisma.deviceToken.findMany({
      where: afterId ? { id: { gt: afterId } } : {},
      orderBy: { id: 'asc' },
      take,
    });
  },

  countAll() {
    return prisma.deviceToken.count();
  },
};
