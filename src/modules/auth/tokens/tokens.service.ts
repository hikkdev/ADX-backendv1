import crypto from 'crypto';
import { env } from '../../../config/env';
import { logger } from '../../../shared/logging';
import { logActivity } from '../../../shared/audit';
import { prismaTokensRepository as repository } from './prisma-tokens.repository';
import type { SessionMeta } from './tokens.repository';

export type { SessionMeta } from './tokens.repository';

function hash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Parses JWT_REFRESH_EXPIRES_IN ("30d", "12h", …); falls back to 30 days. */
function refreshExpiry(): Date {
  const expiresAt = new Date();
  const ttlMatch = String(env.JWT_REFRESH_EXPIRES_IN).match(/^(\d+)([dhms])$/);
  if (ttlMatch?.[1] && ttlMatch?.[2]) {
    const n = parseInt(ttlMatch[1], 10);
    const unit = ttlMatch[2];
    if (unit === 'd') expiresAt.setDate(expiresAt.getDate() + n);
    else if (unit === 'h') expiresAt.setHours(expiresAt.getHours() + n);
    else if (unit === 'm') expiresAt.setMinutes(expiresAt.getMinutes() + n);
    else if (unit === 's') expiresAt.setSeconds(expiresAt.getSeconds() + n);
  } else {
    expiresAt.setDate(expiresAt.getDate() + 30);
  }
  return expiresAt;
}

/** Only the hash is stored; the raw value is returned to the client once. */
export async function createRefreshToken(userId: string, meta: SessionMeta = {}): Promise<string> {
  const raw = crypto.randomBytes(64).toString('hex');
  await repository.create({ userId, tokenHash: hash(raw), expiresAt: refreshExpiry(), meta });
  return raw;
}

export async function rotateRefreshToken(
  raw: string,
  meta: SessionMeta = {},
): Promise<{ userId: string; newRaw: string }> {
  const existing = await repository.findByHash(hash(raw));

  if (!existing) {
    throw new Error('Invalid or expired refresh token');
  }

  if (existing.revokedAt) {
    // Rotation means each refresh token is single-use — seeing an already-
    // revoked one presented again means the raw value leaked (e.g. it was
    // stolen and both the attacker and the legitimate client tried to use
    // it). Revoke the whole session family rather than just this token.
    await revokeAllRefreshTokens(existing.userId);
    logger.warn('Refresh token reuse detected — all sessions revoked', { userId: existing.userId });
    await logActivity(existing.userId, 'REFRESH_TOKEN_REUSE_DETECTED', undefined, {
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    throw new Error('Invalid or expired refresh token');
  }

  if (existing.expiresAt < new Date()) {
    throw new Error('Invalid or expired refresh token');
  }

  await repository.revokeById(existing.id);

  const newRaw = await createRefreshToken(existing.userId, meta);
  return { userId: existing.userId, newRaw };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await repository.revokeByHash(hash(raw));
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await repository.revokeAllForUser(userId);
}

export async function listActiveSessions(userId: string) {
  return repository.listActive(userId);
}

export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  return (await repository.revokeSessionForUser(sessionId, userId)) > 0;
}
