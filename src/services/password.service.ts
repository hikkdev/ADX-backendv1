import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../shared/database';
import { logger } from '../shared/logging';

const RESET_TOKEN_TTL_MINUTES = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Returns the raw token to email to the user; only its hash is persisted.
export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  // Invalidate any previous unused reset tokens for this user.
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { expiresAt: new Date() },
  });

  await prisma.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });
  logger.info('Password reset token issued', { userId });

  return raw;
}

export async function consumePasswordResetToken(raw: string): Promise<string> {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

  const resetToken = await prisma.passwordResetToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!resetToken) {
    throw new Error('Invalid or expired reset token');
  }

  await prisma.passwordResetToken.update({
    where: { id: resetToken.id },
    data: { usedAt: new Date() },
  });

  return resetToken.userId;
}
