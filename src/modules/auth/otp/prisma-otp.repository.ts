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

  createPublisherUser(mobile: string, displayId: string) {
    return prisma.user.create({
      data: { mobile, displayId, roles: { create: { role: 'PUBLISHER' } } },
    });
  },

  createDevLoginUser(mobile: string, role: Role, displayId: string) {
    const last4 = mobile.slice(-4);
    return prisma.user.create({
      data: {
        mobile,
        displayId,
        name: `Dev Login ${last4}`,
        roles: { create: { role } },
        ...(role === 'AGENT_PUBLISHER' || role === 'AGENT_ADVERTISER' ? { agentProfile: { create: {} } } : {}),
        // Q-B: the console's 2FA offers EMAIL once the mobile door has spent
        // SMS; without an address the minted admin could never finish.
        ...(role === 'ADMIN' ? { email: `dev-admin-${last4}@example.com` } : {}),
      },
    });
  },

  createUnregisteredUser(mobile: string, displayId: string) {
    // No roles, no profile: the party record and its role are created when
    // the person chooses PUBLISHER or ADVERTISER after verifying. QR-4: the
    // person's own id is minted here, before any of that.
    return prisma.user.create({ data: { mobile, displayId } });
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
      // The code is checked against the hash — opted back in past the global omit.
      omit: { codeHash: false },
      where: { mobile, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  findLatestUnverifiedByEmail(email: string, purpose: OtpPurpose = 'LOGIN') {
    return prisma.otp.findFirst({
      omit: { codeHash: false },
      where: { email, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  },

  async hasVerifiedEmail(userId: string, email: string) {
    // ED-1: the stamp on the row answers first; the codes answered before
    // the column existed still count, so nobody already proved is asked again.
    const stamped = await prisma.user.count({ where: { id: userId, email, emailVerifiedAt: { not: null } } });
    if (stamped > 0) return true;
    return (await prisma.otp.count({ where: { userId, email, verifiedAt: { not: null } } })) > 0;
  },

  incrementAttempts(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { attempts: { increment: 1 } } });
  },

  markVerified(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { verifiedAt: new Date() } });
  },

  /* ED-1: the email door. */
  findUserById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  findEmailSignup(email: string) {
    // The sign-up code is checked against the hash — opted back in past the global omit.
    return prisma.emailSignup.findUnique({ omit: { codeHash: false }, where: { email } });
  },

  upsertEmailSignup({ email, codeHash, expiresAt }) {
    return prisma.emailSignup.upsert({
      where: { email },
      create: { email, codeHash, expiresAt },
      update: { codeHash, expiresAt, attempts: 0, verifiedAt: null },
    });
  },

  incrementEmailSignupAttempts(id: string) {
    return prisma.emailSignup.update({ where: { id }, data: { attempts: { increment: 1 } } });
  },

  markEmailSignupVerified(id: string) {
    return prisma.emailSignup.update({ where: { id }, data: { verifiedAt: new Date() } });
  },

  deleteEmailSignup(id: string) {
    return prisma.emailSignup.deleteMany({ where: { id } });
  },

  markEmailVerified(userId: string, email: string) {
    return prisma.user.updateMany({
      where: { id: userId, email, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  },

  setPrimaryEmailVerified(userId: string, email: string) {
    return prisma.user.update({ where: { id: userId }, data: { email, emailVerifiedAt: new Date() } });
  },

  async findEmailHolder(email: string) {
    const primary = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (primary) return { which: 'PRIMARY' as const, userId: primary.id };
    const contact = await prisma.userContact.findFirst({ where: { kind: 'EMAIL', value: email }, select: { userId: true } });
    return contact ? { which: 'CONTACT' as const, userId: contact.userId } : null;
  },
};
