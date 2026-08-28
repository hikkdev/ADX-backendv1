import { ApiError } from '../../../shared/errors';
import type { KycStatus, UserKyc } from '../../../shared/database';
import { pageMeta } from '../kyc.schema';
import { prismaUserKycRepository as repository } from './prisma-user-kyc.repository';

export async function listUserKycs(page: number, pageSize: number) {
  const { items, total } = await repository.findPage(page, pageSize);
  return { items, meta: pageMeta(page, pageSize, total) };
}

export async function getMyUserKyc(userId: string) {
  const kyc = await repository.findByUserId(userId);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  return kyc;
}

export async function getUserKycById(id: string) {
  const kyc = await repository.findById(id);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  return kyc;
}

/**
 * Submitting user KYC is an upsert, unlike advertiser KYC where a second
 * submission is a 409. Resubmitting replaces the video and returns the record
 * to PENDING; the caller distinguishes the two cases by status code (200 for a
 * replacement, 201 for a first submission), so the outcome is reported back.
 */
export async function submitUserKyc(
  userId: string,
  selfVideoUrl: string,
): Promise<{ kyc: UserKyc; created: boolean }> {
  const existing = await repository.findByUserId(userId);
  if (existing) {
    return { kyc: await repository.resubmit(userId, selfVideoUrl), created: false };
  }
  return { kyc: await repository.create(userId, selfVideoUrl), created: true };
}

export async function reviewUserKyc(id: string, status: KycStatus, rejectionReason?: string) {
  await getUserKycById(id);
  return repository.review(id, status, rejectionReason ?? null);
}

export async function deleteMyUserKyc(userId: string) {
  await getMyUserKyc(userId);
  await repository.removeByUserId(userId);
}

export async function deleteUserKycById(id: string) {
  await getUserKycById(id);
  await repository.removeById(id);
}
