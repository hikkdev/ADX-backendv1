import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';
import { upperEnum } from '../shared/validation';

const createSchema = z.object({
  selfVideoUrl: z.string().url(),
  // ADMIN-only: submit on behalf of a specific user rather than the caller's own.
  userId: z.string().optional(),
});

const reviewSchema = z.object({
  status: upperEnum(['PENDING', 'VERIFIED', 'REJECTED'] as const),
  rejectionReason: z.string().optional(),
});

export async function createUserKycHandler(req: Request, res: Response): Promise<void> {
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { userId: requestedUserId, selfVideoUrl } = parsed.data;
  if (requestedUserId && !isAdmin) {
    throw new ApiError(403, 'FORBIDDEN', 'Only admins can submit KYC on behalf of another user');
  }
  const userId = requestedUserId ?? req.user!.sub;

  const existing = await prisma.userKyc.findUnique({ where: { userId } });
  if (existing) {
    const updated = await prisma.userKyc.update({
      where: { userId },
      data: { selfVideoUrl, status: 'PENDING', rejectionReason: null, submittedAt: new Date() },
    });
    res.json({ success: true, data: updated });
    return;
  }

  const kyc = await prisma.userKyc.create({
    data: { userId, selfVideoUrl, submittedAt: new Date() },
  });
  res.status(201).json({ success: true, data: kyc });
}

export async function getMyUserKycHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const kyc = await prisma.userKyc.findUnique({ where: { userId } });
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  res.json({ success: true, data: kyc });
}

// ADMIN-only: look up any user's KYC record by its id (for edit flows in the
// admin panel, which doesn't have a "my" session to fall back on).
export async function getUserKycByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const kyc = await prisma.userKyc.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, mobile: true } } },
  });
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  res.json({ success: true, data: kyc });
}

export async function getAllUserKycsHandler(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize'] ?? 20)));

  const [items, total] = await Promise.all([
    prisma.userKyc.findMany({
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, mobile: true } } },
    }),
    prisma.userKyc.count(),
  ]);

  res.json({ success: true, data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

export async function reviewUserKycHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.userKyc.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  const kyc = await prisma.userKyc.update({
    where: { id },
    data: { status: parsed.data.status, rejectionReason: parsed.data.rejectionReason ?? null, reviewedAt: new Date() },
  });
  res.json({ success: true, data: kyc });
}

export async function deleteUserKycHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const existing = await prisma.userKyc.findUnique({ where: { userId } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  await prisma.userKyc.delete({ where: { userId } });
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}

// ADMIN-only: delete any user's KYC record by its id.
export async function deleteUserKycByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const existing = await prisma.userKyc.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  await prisma.userKyc.delete({ where: { id } });
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}
