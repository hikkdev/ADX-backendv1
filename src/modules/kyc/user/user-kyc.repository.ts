import type { KycStatus, UserKyc } from '../../../shared/database';

export interface UserKycRepository {
  findPage(page: number, pageSize: number): Promise<{ items: UserKyc[]; total: number }>;
  findByUserId(userId: string): Promise<UserKyc | null>;
  findById(id: string): Promise<UserKyc | null>;
  create(userId: string, selfVideoUrl: string): Promise<UserKyc>;
  /** Resubmission: replaces the video and sends the record back to PENDING. */
  resubmit(userId: string, selfVideoUrl: string): Promise<UserKyc>;
  review(id: string, status: KycStatus, rejectionReason: string | null): Promise<UserKyc>;
  removeByUserId(userId: string): Promise<unknown>;
  removeById(id: string): Promise<unknown>;
}
