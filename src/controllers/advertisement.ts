import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { upperEnum } from '../lib/zod';

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  photoUrls: z.array(z.string().url()).max(5).default([]),
  // ADMIN-only: create on behalf of a specific advertiser (the admin panel
  // manages advertisements for advertisers who may not be logged in themselves).
  advertiserId: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  photoUrls: z.array(z.string().url()).max(5).optional(),
  status: upperEnum(['DRAFT', 'ACTIVE', 'ARCHIVED'] as const).optional(),
});

export async function createAdvertisementHandler(req: Request, res: Response): Promise<void> {
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { advertiserId: requestedAdvertiserId, ...rest } = parsed.data;
  if (requestedAdvertiserId && !isAdmin) {
    throw new ApiError(403, 'FORBIDDEN', 'Only admins can create an advertisement on behalf of another advertiser');
  }
  const advertiserId = requestedAdvertiserId ?? req.user!.sub;

  const ad = await prisma.advertisement.create({ data: { advertiserId, ...rest } });
  res.status(201).json({ success: true, data: ad });
}

export async function getAllAdvertisementsHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.user!.sub;
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  const page = Math.max(1, Number(req.query['page'] ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query['pageSize'] ?? 20)));

  // Admins can see everyone's advertisements (optionally filtered by advertiserId query param);
  // advertisers only see their own.
  const where = isAdmin
    ? (req.query['advertiserId'] ? { advertiserId: String(req.query['advertiserId']) } : {})
    : { advertiserId };

  const [items, total] = await Promise.all([
    prisma.advertisement.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.advertisement.count({ where }),
  ]);

  res.json({ success: true, data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

export async function getAdvertisementByIdHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const advertiserId = req.user!.sub;
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');

  const ad = await prisma.advertisement.findUnique({ where: { id } });
  if (!ad || (!isAdmin && ad.advertiserId !== advertiserId)) throw new ApiError(404, 'NOT_FOUND', 'Advertisement not found');
  res.json({ success: true, data: ad });
}

export async function updateAdvertisementHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const advertiserId = req.user!.sub;
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');

  const existing = await prisma.advertisement.findUnique({ where: { id } });
  if (!existing || (!isAdmin && existing.advertiserId !== advertiserId)) throw new ApiError(404, 'NOT_FOUND', 'Advertisement not found');

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const ad = await prisma.advertisement.update({ where: { id }, data: parsed.data });
  res.json({ success: true, data: ad });
}

export async function deleteAdvertisementHandler(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const advertiserId = req.user!.sub;
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');

  const existing = await prisma.advertisement.findUnique({ where: { id } });
  if (!existing || (!isAdmin && existing.advertiserId !== advertiserId)) throw new ApiError(404, 'NOT_FOUND', 'Advertisement not found');

  await prisma.advertisement.delete({ where: { id } });
  res.json({ success: true, data: { message: 'Advertisement deleted' } });
}
