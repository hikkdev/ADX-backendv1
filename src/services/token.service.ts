import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { logActivity } from './activityLog.service';
import type { Role } from '../generated/prisma';

export type AccessTokenPayload = {
  sub: string;
  roles: Role[];
};

export function signAccessToken(userId: string, roles: Role[]): string {
  return jwt.sign({ sub: userId, roles } as AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as any,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export type SessionMeta = { userAgent?: string; ipAddress?: string };

export async function createRefreshToken(userId: string, meta: SessionMeta = {}): Promise<string> {
  const raw = crypto.randomBytes(64).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

  const expiresAt = new Date();
  const ttl = String(env.JWT_REFRESH_EXPIRES_IN);
  const ttlMatch = ttl.match(/^(\d+)([dhms])$/);
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

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      lastUsedAt: new Date(),
    },
  });

  return raw;
}

export async function rotateRefreshToken(
  raw: string,
  meta: SessionMeta = {},
): Promise<{ userId: string; newRaw: string }> {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

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

  // Revoke old token
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  const newRaw = await createRefreshToken(existing.userId, meta);
  return { userId: existing.userId, newRaw };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.refreshToken.updateMany({
    where: { tokenHash },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listActiveSessions(userId: string) {
  return prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
  });
}

export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  const result = await prisma.refreshToken.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}
