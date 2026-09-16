import { prisma } from '../../../shared/database';
import type { Otp, RecoveryCode, Role, User } from '../../../shared/database';

/**
 * The reads and writes the second factor needs.
 *
 * It touches `User` (the fallback counter and the 2FA stamp) and `Otp` (the
 * email code, which the OTP service does not issue because its codes are six
 * digits and its email purpose is LOGIN). The SMS half goes through the OTP
 * service itself and is not here.
 */
export type TwoFactorUser = User & { roles: { role: Role }[] };

export interface TwoFactorRepository {
  findUser(userId: string): Promise<TwoFactorUser | null>;
  /** Stamps `twoFactorRequiredAt` the first time an admin is challenged; a no-op after. */
  stampTwoFactorRequired(userId: string): Promise<unknown>;
  /** The newest live code of either 2FA purpose, so verify knows which channel was used. */
  findLatestTwoFactorOtp(userId: string): Promise<Otp | null>;
  expireOutstandingTwoFactorEmail(userId: string): Promise<unknown>;
  createEmailCode(data: { userId: string; email: string; codeHash: string; expiresAt: Date }): Promise<unknown>;
  incrementAttempts(otpId: string): Promise<unknown>;
  markVerified(otpId: string): Promise<unknown>;
  /** Adds one to the counter, resetting it first when the 30-day window has passed. Returns the new count. */
  countEmailFallback(userId: string, windowStart: Date): Promise<number>;
  resetEmailFallback(userId: string): Promise<unknown>;

  /* ── Lot K2: the authenticator app ──────────────────────────── */

  /** The sealed secret and the moment the first code was confirmed — the enrolment. */
  setAuthenticator(userId: string, data: { totpSecretEnc: string; totpEnrolledAt: Date }): Promise<unknown>;
  /** Clears both columns. The codes go separately (`replaceRecoveryCodes(userId, [])`). */
  clearAuthenticator(userId: string): Promise<unknown>;
  /** The old set goes and the new one lands in one transaction. An empty list is a plain delete. */
  replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<unknown>;
  /** Every unspent code, oldest first — compared one by one at sign-in. */
  findUnusedRecoveryCodes(userId: string): Promise<RecoveryCode[]>;
  /** Stamps `usedAt` on one code, only if it is still unspent; true when this call spent it. */
  spendRecoveryCode(codeId: string): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  /** Unspent codes per user, for the admin list — a user with none is absent. */
  countUnusedRecoveryCodesFor(userIds: string[]): Promise<Map<string, number>>;
}

export const prismaTwoFactorRepository: TwoFactorRepository = {
  findUser(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, include: { roles: true } }) as never;
  },

  stampTwoFactorRequired(userId: string) {
    return prisma.user.updateMany({
      where: { id: userId, twoFactorRequiredAt: null },
      data: { twoFactorRequiredAt: new Date() },
    });
  },

  findLatestTwoFactorOtp(userId: string) {
    return prisma.otp.findFirst({
      where: {
        userId,
        purpose: { in: ['TWO_FACTOR', 'TWO_FACTOR_EMAIL'] },
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  expireOutstandingTwoFactorEmail(userId: string) {
    return prisma.otp.updateMany({
      where: { userId, purpose: 'TWO_FACTOR_EMAIL', verifiedAt: null },
      data: { expiresAt: new Date() },
    });
  },

  createEmailCode({ userId, email, codeHash, expiresAt }) {
    return prisma.otp.create({ data: { userId, email, purpose: 'TWO_FACTOR_EMAIL', codeHash, expiresAt } });
  },

  incrementAttempts(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { attempts: { increment: 1 } } });
  },

  markVerified(otpId: string) {
    return prisma.otp.update({ where: { id: otpId }, data: { verifiedAt: new Date() } });
  },

  async countEmailFallback(userId: string, windowStart: Date) {
    // One statement so two sends in the same instant cannot both read "2" and
    // both be allowed: the window reset and the increment are decided by the
    // database from the row's own columns.
    const rows = await prisma.$queryRaw<{ emailOtpFallbackCount: number }[]>`
      UPDATE "User"
         SET "emailOtpFallbackCount" =
               CASE WHEN "emailOtpFallbackResetAt" IS NULL OR "emailOtpFallbackResetAt" < ${windowStart}
                    THEN 1 ELSE "emailOtpFallbackCount" + 1 END,
             "emailOtpFallbackResetAt" =
               CASE WHEN "emailOtpFallbackResetAt" IS NULL OR "emailOtpFallbackResetAt" < ${windowStart}
                    THEN NOW() ELSE "emailOtpFallbackResetAt" END
       WHERE "id" = ${userId}
       RETURNING "emailOtpFallbackCount"
    `;
    return rows[0]?.emailOtpFallbackCount ?? 0;
  },

  resetEmailFallback(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { emailOtpFallbackCount: 0, emailOtpFallbackResetAt: null },
    });
  },

  /* ── Lot K2: the authenticator app ──────────────────────────── */

  setAuthenticator(userId: string, data) {
    return prisma.user.update({ where: { id: userId }, data });
  },

  clearAuthenticator(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnrolledAt: null } });
  },

  replaceRecoveryCodes(userId: string, codeHashes: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId } });
      if (codeHashes.length) await tx.recoveryCode.createMany({ data: codeHashes.map((codeHash) => ({ userId, codeHash })) });
    });
  },

  findUnusedRecoveryCodes(userId: string) {
    return prisma.recoveryCode.findMany({ where: { userId, usedAt: null }, orderBy: { createdAt: 'asc' } });
  },

  async spendRecoveryCode(codeId: string) {
    // Narrowed to the unspent row, so two sign-ins racing on the same code
    // get one success and one refusal rather than two sessions.
    const result = await prisma.recoveryCode.updateMany({ where: { id: codeId, usedAt: null }, data: { usedAt: new Date() } });
    return result.count > 0;
  },

  countUnusedRecoveryCodes(userId: string) {
    return prisma.recoveryCode.count({ where: { userId, usedAt: null } });
  },

  async countUnusedRecoveryCodesFor(userIds: string[]) {
    const out = new Map<string, number>();
    if (userIds.length === 0) return out;
    const rows = await prisma.recoveryCode.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, usedAt: null },
      _count: { _all: true },
    });
    for (const row of rows) out.set(row.userId, row._count._all);
    return out;
  },
};
