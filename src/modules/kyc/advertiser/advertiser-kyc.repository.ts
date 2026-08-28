import type { AdvertiserKyc, KycStatus } from '../../../shared/database';
import type { CreateAdvertiserKycInput, UpdateAdvertiserKycInput } from './advertiser-kyc.schema';

export type AdvertiserKycFilter = { status?: KycStatus };

export interface AdvertiserKycRepository {
  findPage(
    where: AdvertiserKycFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: AdvertiserKyc[]; total: number }>;
  findByAdvertiserId(advertiserId: string): Promise<AdvertiserKyc | null>;
  findById(id: string): Promise<AdvertiserKyc | null>;
  create(advertiserId: string, data: CreateAdvertiserKycInput): Promise<AdvertiserKyc>;
  /** Resubmission by the owner: resets the record to PENDING. */
  resubmit(advertiserId: string, data: UpdateAdvertiserKycInput): Promise<AdvertiserKyc>;
  /** Admin edit by id: does not touch status. */
  updateById(id: string, data: UpdateAdvertiserKycInput): Promise<AdvertiserKyc>;
  review(id: string, status: KycStatus, rejectionReason: string | null): Promise<AdvertiserKyc>;
  remove(id: string): Promise<unknown>;
}
