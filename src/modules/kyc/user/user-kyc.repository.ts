import type { KycStatus, UserKyc, UserKycPurpose } from '../../../shared/database';

export interface UserKycRepository {
  findPage(page: number, pageSize: number): Promise<{ items: UserKyc[]; total: number }>;
  findByUserId(userId: string): Promise<UserKyc | null>;
  findById(id: string): Promise<UserKyc | null>;
  create(userId: string, selfVideoUrl: string): Promise<UserKyc>;
  /** Resubmission: replaces the video and sends the record back to PENDING. */
  resubmit(userId: string, selfVideoUrl: string): Promise<UserKyc>;
  /**
   * Lot D (Q131): the liveness video — an upsert with its purpose and who
   * recorded it, back to PENDING with the reason cleared.
   */
  /** E6: `fileId` is the private file behind the video (Lot E column), kept beside the URL. */
  upsertLiveness(userId: string, selfVideoUrl: string, recordedById: string, fileId: string): Promise<{ kyc: UserKyc; created: boolean }>;
  /**
   * Lot N: an admin attests the person's presence — the row is upserted
   * VERIFIED, purpose LIVENESS, with who, when and the note; a video already
   * on the row stays. `created` says whether the row is new.
   */
  attest(userId: string, stamp: { attestedById: string; attestationNote: string; at: Date }): Promise<{ kyc: UserKyc; created: boolean }>;
  review(id: string, status: KycStatus, rejectionReason: string | null): Promise<UserKyc>;
  removeByUserId(userId: string): Promise<unknown>;
  removeById(id: string): Promise<unknown>;
  /** Lot D (Q127): VERIFIED liveness rows still holding a video, verified before `cutoff`. */
  findPurgeable(purpose: UserKycPurpose, cutoff: Date, limit: number): Promise<UserKyc[]>;
  /** Drops the video, keeps when it was recorded and what was said. */
  purgeVideo(id: string): Promise<UserKyc>;
}
