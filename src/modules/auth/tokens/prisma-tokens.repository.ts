import { prisma } from '../../../shared/database';
import type { SessionMeta, TokensRepository } from './tokens.repository';

export const prismaTokensRepository: TokensRepository = {
  create({ userId, tokenHash, expiresAt, meta }: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    meta: SessionMeta;
  }) {
    return prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
        lastUsedAt: new Date(),
      },
    });
  },

  findByHash(tokenHash: string) {
    return prisma.refreshToken.findUnique({ where: { tokenHash } });
  },

  revokeById(id: string) {
    return prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
  },

  revokeByHash(tokenHash: string) {
    return prisma.refreshToken.updateMany({ where: { tokenHash }, data: { revokedAt: new Date() } });
  },

  revokeAllForUser(userId: string) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async revokeOthersForUser(userId: string, keepSessionId: string) {
    const result = await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, id: { not: keepSessionId } },
      data: { revokedAt: new Date() },
    });
    return result.count;
  },

  listActive(userId: string) {
    return prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
    });
  },

  async revokeSessionForUser(sessionId: string, userId: string) {
    const result = await prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  },
};
