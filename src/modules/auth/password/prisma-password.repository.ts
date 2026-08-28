import { prisma } from '../../../shared/database';
import type { PasswordRepository } from './password.repository';

export const prismaPasswordRepository: PasswordRepository = {
  expireOutstandingResetTokens(userId: string) {
    return prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { expiresAt: new Date() },
    });
  },

  createResetToken(data) {
    return prisma.passwordResetToken.create({ data });
  },

  findUsableResetToken(tokenHash: string) {
    return prisma.passwordResetToken.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    });
  },

  markResetTokenUsed(id: string) {
    return prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
  },
};
