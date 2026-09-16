import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import type { KycStatus, UserKyc } from '../../../shared/database';
import { fileIdFromUrl, findUploadedFile, purgeStoredFile } from '../../uploads';
import { pageMeta } from '../kyc.schema';
import type { AttestationInput } from './user-kyc.schema';
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

/**
 * Lot D (Q131): the liveness video, in the party's own hands.
 *
 * The phone uploads the clip as a private USER_KYC file and names it here;
 * the row keeps the file's `/files/:id` URL, its purpose, and who recorded
 * it. The file has to be the caller's own — an id lifted from someone else's
 * upload is refused, not adopted. Back to PENDING every time, so a fresh
 * recording after a rejection is reviewed again.
 */
export async function submitLiveness(userId: string, fileId: string): Promise<{ kyc: UserKyc; created: boolean }> {
  const file = await findUploadedFile(fileId);
  if (!file || file.purpose !== 'USER_KYC') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Upload the video with purpose USER_KYC first');
  }
  if ((file.ownerUserId ?? file.userId) !== userId) {
    throw new ApiError(403, 'FORBIDDEN', 'That file is not yours');
  }
  // E6: the file id on the row (Lot E column), so the case read is exact.
  return repository.upsertLiveness(userId, file.url, userId, file.id);
}

/**
 * Lot N: the desk records the liveness video it captured on the person's
 * behalf — the file uploaded by the admin under purpose USER_KYC, either
 * with `ownerUserId` naming the party or under the admin's own hand. A file
 * that is neither the party's nor the admin's is refused, as the self path
 * refuses a lifted id. `recordedById` is the admin; audited.
 */
export async function submitLivenessOnBehalf(userId: string, fileId: string, byUserId: string, req?: Request): Promise<{ kyc: UserKyc; created: boolean }> {
  const file = await findUploadedFile(fileId);
  if (!file || file.purpose !== 'USER_KYC') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Upload the video with purpose USER_KYC first');
  }
  const owner = file.ownerUserId ?? file.userId;
  if (owner !== userId && !(file.ownerUserId === null && file.userId === byUserId)) {
    throw new ApiError(403, 'FORBIDDEN', 'That file is neither this person’s nor your own upload');
  }
  const result = await repository.upsertLiveness(userId, file.url, byUserId, file.id);
  await logActivity(byUserId, 'USER_KYC_LIVENESS_RECORDED_AT_DESK', {
    req,
    targetType: 'UserKyc',
    targetId: result.kyc.id,
    module: 'kyc',
    metadata: { userId, fileId: file.id, created: result.created },
  });
  return result;
}

/**
 * Lot N: presence attested at the desk. An admin who met the person — in
 * person, or on a call — says so instead of a video: the row is upserted
 * VERIFIED with who, when and the note, and `hasSubmittedLiveness` treats
 * it as satisfied, so a desk-recorded manual KYC can be VERIFIED. Audited
 * `USER_KYC_PRESENCE_ATTESTED`; the note is the evidence.
 */
export async function attestPresence(userId: string, input: AttestationInput, byUserId: string, req?: Request, now = new Date()): Promise<{ kyc: UserKyc; created: boolean }> {
  const result = await repository.attest(userId, { attestedById: byUserId, attestationNote: input.note, at: now });
  await logActivity(byUserId, 'USER_KYC_PRESENCE_ATTESTED', {
    req,
    targetType: 'UserKyc',
    targetId: result.kyc.id,
    module: 'kyc',
    metadata: { userId, note: input.note, attestedAt: now.toISOString(), created: result.created },
  });
  return result;
}

export type LivenessState = {
  id: string;
  status: KycStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  /** The private file behind the video, or null once purged or for a pre-Lot-D URL. */
  fileId: string | null;
  recordedById: string | null;
  /** Lot N: presence attested at the desk instead of (or beside) a video — who, when, how. */
  attestedById: string | null;
  attestedAt: Date | null;
  attestationNote: string | null;
};

/** The liveness row for a user, for the case read and the manifest. Null when nothing is recorded. */
export async function livenessStateFor(userId: string): Promise<LivenessState | null> {
  const row = await repository.findByUserId(userId);
  if (!row || row.purpose !== 'LIVENESS') return null;
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    rejectionReason: row.rejectionReason,
    // E6: the column first; the URL parse only for rows written before Lot E.
    fileId: row.fileId ?? fileIdFromUrl(row.selfVideoUrl),
    recordedById: row.recordedById,
    attestedById: row.attestedById ?? null,
    attestedAt: row.attestedAt ?? null,
    attestationNote: row.attestationNote ?? null,
  };
}

/**
 * Q131's gate: a manual-path review may verify only once a liveness video is
 * in and not rejected — or (Lot N) an admin has attested the person's
 * presence at the desk.
 */
export async function hasSubmittedLiveness(userId: string): Promise<boolean> {
  const row = await repository.findByUserId(userId);
  if (!row || row.purpose !== 'LIVENESS' || row.status === 'REJECTED') return false;
  return row.submittedAt !== null || (row.attestedAt ?? null) !== null;
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

/**
 * Lot D (Q127): liveness videos are kept thirty days past verification and
 * then dropped — the file and the URL — keeping when it was recorded, who
 * recorded it and the decision. Returns the row ids purged, for the audit.
 */
export async function purgeVerifiedLivenessVideos(cutoff: Date, limit = 200): Promise<{ userKycId: string; userId: string }[]> {
  const rows = await repository.findPurgeable('LIVENESS', cutoff, limit);
  const purged: { userKycId: string; userId: string }[] = [];
  for (const row of rows) {
    const fileId = row.fileId ?? fileIdFromUrl(row.selfVideoUrl);
    if (fileId) await purgeStoredFile(fileId);
    await repository.purgeVideo(row.id);
    purged.push({ userKycId: row.id, userId: row.userId });
  }
  return purged;
}
