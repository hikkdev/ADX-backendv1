import { ApiError } from '../../../shared/errors';
import type { KycStatus } from '../../../shared/database';
import { pageMeta } from '../kyc.schema';
import { prismaAdvertiserKycRepository as repository } from './prisma-advertiser-kyc.repository';
import type { AdvertiserKycFilter } from './advertiser-kyc.repository';
import type { CreateAdvertiserKycInput, UpdateAdvertiserKycInput } from './advertiser-kyc.schema';

export async function listAdvertiserKycs(
  where: AdvertiserKycFilter,
  page: number,
  pageSize: number,
) {
  const { items, total } = await repository.findPage(where, page, pageSize);
  return { items, meta: pageMeta(page, pageSize, total) };
}

export async function getMyAdvertiserKyc(advertiserId: string) {
  const kyc = await repository.findByAdvertiserId(advertiserId);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  return kyc;
}

export async function getAdvertiserKycById(id: string) {
  const kyc = await repository.findById(id);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'KYC not found');
  return kyc;
}

/**
 * One KYC record per advertiser. Unlike user KYC, a second submission is a
 * conflict rather than an overwrite — the advertiser is expected to use
 * PUT /me to resubmit.
 */
export async function createAdvertiserKyc(advertiserId: string, data: CreateAdvertiserKycInput) {
  const existing = await repository.findByAdvertiserId(advertiserId);
  if (existing) throw new ApiError(409, 'CONFLICT', 'KYC already submitted for this advertiser');
  return repository.create(advertiserId, data);
}

/** Owner resubmission: edits the documents and sends the record back to PENDING. */
export async function resubmitAdvertiserKyc(
  advertiserId: string,
  data: UpdateAdvertiserKycInput,
) {
  await getMyAdvertiserKyc(advertiserId);
  return repository.resubmit(advertiserId, data);
}

/** Admin edit by id. Does NOT reset status — that is what review is for. */
export async function updateAdvertiserKycById(id: string, data: UpdateAdvertiserKycInput) {
  await getAdvertiserKycById(id);
  return repository.updateById(id, data);
}

export async function reviewAdvertiserKyc(
  id: string,
  status: KycStatus,
  rejectionReason?: string,
) {
  await getAdvertiserKycById(id);
  return repository.review(id, status, rejectionReason ?? null);
}

export async function deleteAdvertiserKyc(id: string) {
  await getAdvertiserKycById(id);
  await repository.remove(id);
}
