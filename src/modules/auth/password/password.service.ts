import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../../config/env';
import { passwordResetEmail, sendEmail } from '../../../shared/email';
import { logger } from '../../../shared/logging';
import { prismaPasswordRepository as repository } from './prisma-password.repository';

const RESET_TOKEN_TTL_MINUTES = 30;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * E6: the same link `POST /auth/forgot-password` sends, raised from the desk
 * (`POST /users/:id/reset-password`). The token is minted and emailed here so
 * the raw value never crosses a module boundary.
 */
export async function sendPasswordResetLink(userId: string, email: string): Promise<void> {
  const raw = await createPasswordResetToken(userId);
  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${raw}`;
  const { subject, html } = passwordResetEmail(resetUrl);
  // AE-B: by the one door — SMTP, Resend or the Ethereal inbox, as the row says.
  await sendEmail(email, subject, html);
}

/** Returns the raw token to email to the user; only its hash is persisted. */
export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  // Invalidate any previous unused reset tokens for this user, so requesting a
  // new link immediately retires the old one.
  await repository.expireOutstandingResetTokens(userId);
  await repository.createResetToken({ userId, tokenHash, expiresAt });
  logger.info('Password reset token issued', { userId });

  return raw;
}

export async function consumePasswordResetToken(raw: string): Promise<string> {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

  const resetToken = await repository.findUsableResetToken(tokenHash);

  if (!resetToken) {
    throw new Error('Invalid or expired reset token');
  }

  await repository.markResetTokenUsed(resetToken.id);

  return resetToken.userId;
}
