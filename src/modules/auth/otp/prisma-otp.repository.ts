import { prisma } from '../../../shared/database';
import type { OtpPurpose } from '../../../shared/database';
import type { OtpRepository } from './otp.repository';

export const prismaOtpRepository: OtpRepository = {
  findUserByMobile(mobile: string) {
    return prisma.user.findUnique({ where: { mobile } });
  },

  findUserByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  createPublisherUser(mobile: string) {
    return prisma.user.create({
      data: { mobile, roles: { create: { role: 'PUBLISHER' } } },
    });
  },

  createDevLoginUser(mobile: string) {
    return prisma.user.create({
      data: {
        mobile,
        name: `Dev Login ${mobile.slice(-4)}`,
        roles: { create: { role: 'AGENT_PUBLISHER' } },
        agentProfile: { create: {} },
      },
    });
  },

  expireOutstandingByMobile(mobile: string, purpose: OtpPurpose) {
    return prisma.otp.updateMany({
      where: { mobile, purpose, verifiedAt: null },
      data: { expiresAt: new Date() },
    });
  },

  expireOutstandingByEmail(email: string) {
    return prisma.otp.updateMany({
      where: { email, purpose: 'LOGIN', verifiedAt: null },
      data: { expiresAt: new Date() },
    });
  },

  createForMobile(data) {
    return prisma.otp.create({ data });
  },

  createForEmail({ userId, email, codeHash, expiresAt }) {
    return prisma.otp.create({
      data: { userId, email, purpose: 'LOGIN', codeHash, expiresAt },
    });
  },

  findLatestUnverifiedByMobile(mobile: string, purpose: OtpPurpose) {
    return prisma.otp.findFirst({
      where: { mobile, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  findLatestUnverifiedByEmail(email: string) {
    return prisma.otp.findFirst({
      where: { email, purpose: 'LOGIN', verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  incrementAttempts(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { attempts: { increment: 1 } } });
  },

  markVerified(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { verifiedAt: new Date() } });
  },
};
