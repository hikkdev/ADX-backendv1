import type { Request } from 'express';
import type { Prisma } from '../generated/prisma';
import { prisma } from '../lib/prisma';

export async function logActivity(
  userId: string,
  action: string,
  req?: Request,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId,
      action,
      metadata: metadata as Prisma.InputJsonValue | undefined,
      ipAddress: req?.ip,
      userAgent: req?.headers['user-agent'],
    },
  });
}

export async function listActivity(userId: string, limit = 50) {
  return prisma.activityLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
