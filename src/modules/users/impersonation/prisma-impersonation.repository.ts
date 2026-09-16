import { prisma } from '../../../shared/database';
import type { ImpersonationSession, Role, User } from '../../../shared/database';

export type ImpersonationTarget = User & { roles: { role: Role }[] };

export interface ImpersonationRepository {
  findTarget(userId: string): Promise<ImpersonationTarget | null>;
  start(data: {
    adminUserId: string;
    targetUserId: string;
    reason: string;
    expiresAt: Date;
  }): Promise<ImpersonationSession>;
  findById(id: string): Promise<ImpersonationSession | null>;
  end(id: string): Promise<ImpersonationSession>;
  listOpenFor(adminUserId: string, now: Date): Promise<ImpersonationSession[]>;
}

export const prismaImpersonationRepository: ImpersonationRepository = {
  findTarget(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, include: { roles: true } }) as never;
  },

  start({ adminUserId, targetUserId, reason, expiresAt }) {
    return prisma.impersonationSession.create({
      data: { adminUserId, targetUserId, reason, scope: 'READ', expiresAt },
    });
  },

  findById(id: string) {
    return prisma.impersonationSession.findUnique({ where: { id } });
  },

  end(id: string) {
    return prisma.impersonationSession.update({ where: { id }, data: { endedAt: new Date() } });
  },

  listOpenFor(adminUserId: string, now: Date) {
    return prisma.impersonationSession.findMany({
      where: { adminUserId, endedAt: null, expiresAt: { gt: now } },
      orderBy: { startedAt: 'desc' },
    });
  },
};
