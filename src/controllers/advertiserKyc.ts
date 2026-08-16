import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { upperEnum } from '../lib/zod';

const documentFields = {
  nationalIdUrl: z.string().url().optional(),
  panCardUrl: z.string().url().optional(),
  utilityBillUrl: z.string().url().optional(),
  drivingLicenseUrl: z.string().url().optional(),
  commercialIncCertUrl: z.string().url().optional(),
  commercialAssociationArticleUrl: z.string().url().optional(),
  commercialPanIdUrl: z.string().url().optional(),
  commercialGstCertUrl: z.string().url().optional(),
  ngoRegCertUrl: z.string().url().optional(),
  ngo80gCertUrl: z.string().url().optional(),
  ngoFcraRegUrl: z.string().url().optional(),
  agencyAuthLetterUrl: z.string().url().optional(),
  agencyGovtIdUrl: z.string().url().optional(),
};

const createSchema = z.object({
  kycType: z.enum(['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY']).default('INDIVIDUAL'),
  ...documentFields,
});

const updateSchema = z.object({
  kycType: z.enum(['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY']).optional(),
  ...documentFields,
});

const reviewSchema = z.object({
  status: upperEnum(['PENDING', 'VERIFIED', 'REJECTED'] as const),
  rejectionReason: z.string().optional(),
});

export async function createAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.user!.sub;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.advertiserKyc.findUnique({ where: { advertiserId } });
  if (existing) throw new ApiError(409, 'CONFLICT', 'KYC already submitted for this advertiser');

  const kyc = await prisma.advertiserKyc.create({
    data: { advertiserId, ...parsed.data, submittedAt: new Date() },
  });
  res.status(201).json({ success: true, data: kyc });
}

export async function getMyAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.user!.sub;
  const kyc = await prisma.advertiserKyc.findUnique({ where: { advertiserId } });
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  res.json({ success: true, data: kyc });
}

export async function getAllAdvertiserKycsHandler(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize'] ?? 20)));
  const statusFilter = z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional().safeParse(req.query['status']);
  const where = statusFilter.success && statusFilter.data ? { status: statusFilter.data } : {};

  const [items, total] = await Promise.all([
    prisma.advertiserKyc.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { advertiser: { select: { id: true, name: true, mobile: true, email: true } } },
    }),
    prisma.advertiserKyc.count({ where }),
  ]);

  res.json({ success: true, data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

export async function getAdvertiserKycByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const kyc = await prisma.advertiserKyc.findUnique({ where: { id } });
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  res.json({ success: true, data: kyc });
}

export async function updateAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.user!.sub;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.advertiserKyc.findUnique({ where: { advertiserId } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  const kyc = await prisma.advertiserKyc.update({
    where: { advertiserId },
    data: { ...parsed.data, status: 'PENDING', rejectionReason: null, submittedAt: new Date() },
  });
  res.json({ success: true, data: kyc });
}

// ADMIN-only: update any advertiser's KYC record by its id.
export async function updateAdvertiserKycByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.advertiserKyc.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  const kyc = await prisma.advertiserKyc.update({
    where: { id },
    data: parsed.data,
  });
  res.json({ success: true, data: kyc });
}

export async function reviewAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const existing = await prisma.advertiserKyc.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  const kyc = await prisma.advertiserKyc.update({
    where: { id },
    data: { status: parsed.data.status, rejectionReason: parsed.data.rejectionReason ?? null, reviewedAt: new Date() },
  });
  res.json({ success: true, data: kyc });
}

export async function deleteAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const existing = await prisma.advertiserKyc.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');

  await prisma.advertiserKyc.delete({ where: { id } });
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}
