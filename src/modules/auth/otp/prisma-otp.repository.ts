import { prisma } from '../../../shared/database';
import type { OtpPurpose, Role } from '../../../shared/database';
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

  createDevLoginUser(mobile: string, role: Role) {
    const last4 = mobile.slice(-4);
    return prisma.user.create({
      data: {
        mobile,
        name: `Dev Login ${last4}`,
        roles: { create: { role } },
        ...(role === 'AGENT_PUBLISHER' || role === 'AGENT_ADVERTISER' ? { agentProfile: { create: {} } } : {}),
        // Q-B: the console's 2FA offers EMAIL once the mobile door has spent
        // SMS; without an address the minted admin could never finish.
        ...(role === 'ADMIN' ? { email: `dev-admin-${last4}@adx.local` } : {}),
      },
    });
  },

  createUnregisteredUser(mobile: string) {
    // No roles, no profile: the party record and its role are created when
    // the person chooses PUBLISHER or ADVERTISER after verifying.
    return prisma.user.create({ data: { mobile } });
  },

  markMobileVerified(userId: string) {
    // updateMany so the filter can include the null check — the first
    // verification stamps it, every later one leaves the original alone.
    return prisma.user.updateMany({
      where: { id: userId, mobileVerifiedAt: null },
      data: { mobileVerifiedAt: new Date() },
    });
  },

  expireOutstandingByMobile(mobile: string, purpose: OtpPurpose) {
    return prisma.otp.updateMany({
      where: { mobile, purpose, verifiedAt: null },
      data: { expiresAt: new Date() },
    });
  },

  expireOutstandingByEmail(email: string, purpose: OtpPurpose = 'LOGIN') {
    return prisma.otp.updateMany({
      where: { email, purpose, verifiedAt: null },
      data: { expiresAt: new Date() },
    });
  },

  expireOutstandingForUser(userId: string) {
    return prisma.otp.updateMany({
      where: { userId, verifiedAt: null, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date() },
    });
  },

  createForMobile(data) {
    return prisma.otp.create({ data });
  },

  createForEmail({ userId, email, codeHash, expiresAt, purpose = 'LOGIN' }) {
    return prisma.otp.create({
      data: { userId, email, purpose, codeHash, expiresAt },
    });
  },

  findLatestUnverifiedByMobile(mobile: string, purpose: OtpPurpose) {
    return prisma.otp.findFirst({
      where: { mobile, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  findLatestUnverifiedByEmail(email: string, purpose: OtpPurpose = 'LOGIN') {
    return prisma.otp.findFirst({
      where: { email, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  async hasVerifiedEmail(userId: string, email: string) {
    return (await prisma.otp.count({ where: { userId, email, verifiedAt: { not: null } } })) > 0;
  },

  incrementAttempts(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { attempts: { increment: 1 } } });
  },

  markVerified(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { verifiedAt: new Date() } });
  },
};
