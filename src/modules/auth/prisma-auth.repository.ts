import { prisma } from '../../shared/database';
import type { AuthRepository } from './auth.repository';

// The full join every non-publisher login response is built from.
const loginInclude = {
  roles: true,
  agentProfile: true,
  publisherProfile: { include: { kyc: true } },
} as const;

export const prismaAuthRepository: AuthRepository = {
  findLoginUserById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, include: loginInclude }) as never;
  },

  findLoginUserByEmail(email: string) {
    return prisma.user.findUnique({ where: { email }, include: loginInclude }) as never;
  },

  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  findUserWithRoles(userId: string) {
    // Refresh only needs the roles to re-sign an access token, so it
    // deliberately skips the profile joins.
    return prisma.user.findUnique({ where: { id: userId }, include: { roles: true } }) as never;
  },

  findPublisherLoginUserById(userId: string) {
    // No agentProfile and no KYC join — the publisher app does not render them.
    return prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true, publisherProfile: true },
    }) as never;
  },

  findByMobileWithRoles(mobile: string) {
    return prisma.user.findUnique({ where: { mobile }, include: { roles: true } }) as never;
  },

  findById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  recordLogin(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  },

  setPasswordHash(userId: string, passwordHash: string) {
    return prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  },

  setName(userId: string, name: string) {
    return prisma.user.update({ where: { id: userId }, data: { name } });
  },
};
