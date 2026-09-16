import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { KycStatus } from '../../../shared/database';
import { pagination, reviewSchema } from '../kyc.schema';
import { attestationSchema, createUserKycSchema, livenessSchema } from './user-kyc.schema';
import {
  attestPresence,
  deleteMyUserKyc,
  deleteUserKycById,
  getMyUserKyc,
  getUserKycById,
  listUserKycs,
  reviewUserKyc,
  submitLiveness,
  submitLivenessOnBehalf,
  submitUserKyc,
} from './user-kyc.service';

// POST /user-kyc/:userId/attest — Lot N: presence attested at the desk instead of a video.
export async function attestPresenceHandler(req: Request, res: Response): Promise<void> {
  const parsed = attestationSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const { kyc, created } = await attestPresence(req.params['userId'] as string, parsed.data, req.user!.sub, req);
  res.status(created ? 201 : 200).json({ success: true, data: kyc });
}

// POST /user-kyc/:userId — Lot N: the liveness video the desk captured on the person's behalf.
export async function submitLivenessOnBehalfHandler(req: Request, res: Response): Promise<void> {
  const parsed = livenessSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const { kyc, created } = await submitLivenessOnBehalf(req.params['userId'] as string, parsed.data.fileId, req.user!.sub, req);
  res.status(created ? 201 : 200).json({ success: true, data: kyc });
}

// POST /user-kyc/me — Lot D (Q131): the liveness video, by private file id.
export async function submitLivenessHandler(req: Request, res: Response): Promise<void> {
  const parsed = livenessSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const { kyc, created } = await submitLiveness(req.user!.sub, parsed.data.fileId);
  res.status(created ? 201 : 200).json({ success: true, data: kyc });
}

export async function createUserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = createUserKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { userId: requestedUserId, selfVideoUrl } = parsed.data;
  if (requestedUserId && !(req.user?.roles ?? []).includes('ADMIN')) {
    throw new ApiError(403, 'FORBIDDEN', 'Only admins can submit KYC on behalf of another user');
  }

  const { kyc, created } = await submitUserKyc(requestedUserId ?? req.user!.sub, selfVideoUrl);
  // 201 for a first submission, 200 when an existing record was replaced.
  res.status(created ? 201 : 200).json({ success: true, data: kyc });
}

export async function getMyUserKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyUserKyc(req.user!.sub) });
}

export async function getUserKycByIdHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getUserKycById(req.params['id'] as string) });
}

export async function getAllUserKycsHandler(req: Request, res: Response): Promise<void> {
  const { page, pageSize } = pagination(req.query as Record<string, unknown>);
  const { items, meta } = await listUserKycs(page, pageSize);
  res.json({ success: true, data: items, meta });
}

export async function reviewUserKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const kyc = await reviewUserKyc(
    req.params['id'] as string,
    parsed.data.status as KycStatus,
    parsed.data.rejectionReason,
  );
  res.json({ success: true, data: kyc });
}

export async function deleteUserKycHandler(req: Request, res: Response): Promise<void> {
  await deleteMyUserKyc(req.user!.sub);
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}

export async function deleteUserKycByIdHandler(req: Request, res: Response): Promise<void> {
  await deleteUserKycById(req.params['id'] as string);
  res.json({ success: true, data: { message: 'KYC record deleted' } });
}
