import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { KycStatus } from '../../../shared/database';
import { pagination, reviewSchema } from '../kyc.schema';
import {
  advertiserKycStatusFilterSchema,
  createAdvertiserKycSchema,
  updateAdvertiserKycSchema,
} from './advertiser-kyc.schema';
import {
  createAdvertiserKyc,
  deleteAdvertiserKyc,
  getAdvertiserKycById,
  getMyAdvertiserKyc,
  listAdvertiserKycs,
  resubmitAdvertiserKyc,
  reviewAdvertiserKyc,
  updateAdvertiserKycById,
} from './advertiser-kyc.service';

export async function createAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = createAdvertiserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await createAdvertiserKyc(req.user!.sub, parsed.data);
  res.status(201).json({ success: true, data: kyc });
}

export async function getMyAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyAdvertiserKyc(req.user!.sub) });
}

export async function getAllAdvertiserKycsHandler(req: Request, res: Response): Promise<void> {
  const { page, pageSize } = pagination(req.query as Record<string, unknown>);

  // An unparseable status is ignored rather than rejected — the listing falls
  // back to unfiltered. Inherited behaviour; do not turn this into a 400.
  const statusFilter = advertiserKycStatusFilterSchema.safeParse(req.query['status']);
  const where = statusFilter.success && statusFilter.data ? { status: statusFilter.data } : {};

  const { items, meta } = await listAdvertiserKycs(where, page, pageSize);
  res.json({ success: true, data: items, meta });
}

export async function getAdvertiserKycByIdHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAdvertiserKycById(req.params['id'] as string) });
}

export async function updateAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateAdvertiserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await resubmitAdvertiserKyc(req.user!.sub, parsed.data);
  res.json({ success: true, data: kyc });
}

export async function updateAdvertiserKycByIdHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateAdvertiserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await updateAdvertiserKycById(req.params['id'] as string, parsed.data);
  res.json({ success: true, data: kyc });
}

export async function reviewAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await reviewAdvertiserKyc(
    req.params['id'] as string,
    parsed.data.status as KycStatus,
    parsed.data.rejectionReason,
  );
  res.json({ success: true, data: kyc });
}

export async function deleteAdvertiserKycHandler(req: Request, res: Response): Promise<void> {
  await deleteAdvertiserKyc(req.params['id'] as string);
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}
