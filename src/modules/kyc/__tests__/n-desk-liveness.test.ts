import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot N — presence at the desk.
 *
 * The manual path needs proof the person behind the documents is present.
 * Until now that was only the liveness video the party recorded. An admin
 * who met the person — in person at the desk, or on a video call — may now
 * attest it instead (`POST /user-kyc/:userId/attest { note }`), or record a
 * video the desk captured on their behalf (`POST /user-kyc/:userId
 * { fileId }`). The gate a manual-path review asks (`hasSubmittedLiveness`)
 * treats an attested row as satisfied, so a desk-recorded KYC can be
 * VERIFIED; the case read says who attested and how.
 */

const { userRepo, uploads, audit } = vi.hoisted(() => ({
  userRepo: { upsertLiveness: vi.fn(), findByUserId: vi.fn(), attest: vi.fn() },
  uploads: {
    purgeStoredFile: vi.fn(),
    findUploadedFile: vi.fn(),
    fileIdFromUrl: (url: string | null) => (url ? (/\/files\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null),
  },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
}));

vi.mock('../user/prisma-user-kyc.repository', () => ({ prismaUserKycRepository: userRepo }));
vi.mock('../../uploads', () => uploads);
vi.mock('../../../shared/audit', () => audit);

import { attestPresence, hasSubmittedLiveness, livenessStateFor, submitLivenessOnBehalf } from '../user/user-kyc.service';
import { attestationSchema } from '../user/user-kyc.schema';

const NOW = new Date('2026-09-14T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  userRepo.upsertLiveness.mockResolvedValue({ kyc: { id: 'ukyc_1', userId: 'usr_1', purpose: 'LIVENESS', status: 'PENDING' }, created: true });
  userRepo.attest.mockImplementation(async (userId: string, stamp: { attestedById: string; attestationNote: string; at: Date }) => ({
    kyc: { id: 'ukyc_1', userId, purpose: 'LIVENESS', status: 'VERIFIED', submittedAt: null, attestedById: stamp.attestedById, attestedAt: stamp.at, attestationNote: stamp.attestationNote },
    created: false,
  }));
});

describe('the attestation body', () => {
  it('needs a note saying how the person was met', () => {
    expect(attestationSchema.safeParse({}).success).toBe(false);
    expect(attestationSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(attestationSchema.parse({ note: 'met in person at the Pune desk' })).toEqual({ note: 'met in person at the Pune desk' });
  });
});

describe('POST /user-kyc/:userId/attest', () => {
  it('upserts the row VERIFIED with who attested, when and how, and audits it', async () => {
    const result = await attestPresence('usr_1', { note: 'video call on 14 Sep' }, 'usr_admin', undefined, NOW);
    expect(userRepo.attest).toHaveBeenCalledWith('usr_1', { attestedById: 'usr_admin', attestationNote: 'video call on 14 Sep', at: NOW });
    expect(result.kyc).toMatchObject({ status: 'VERIFIED', attestedById: 'usr_admin', attestedAt: NOW, attestationNote: 'video call on 14 Sep' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'USER_KYC_PRESENCE_ATTESTED',
      expect.objectContaining({ targetType: 'UserKyc', targetId: 'ukyc_1', module: 'kyc', metadata: expect.objectContaining({ userId: 'usr_1', note: 'video call on 14 Sep' }) }),
    );
  });
});

describe('the liveness gate', () => {
  it('is satisfied by an attested row with no video', async () => {
    userRepo.findByUserId.mockResolvedValue({ id: 'ukyc_1', purpose: 'LIVENESS', status: 'VERIFIED', submittedAt: null, attestedAt: NOW, attestedById: 'usr_admin', selfVideoUrl: null, fileId: null });
    expect(await hasSubmittedLiveness('usr_1')).toBe(true);
  });

  it('is still not satisfied by a row with neither a video nor an attestation, or a rejected one', async () => {
    userRepo.findByUserId.mockResolvedValue({ id: 'ukyc_1', purpose: 'LIVENESS', status: 'PENDING', submittedAt: null, attestedAt: null });
    expect(await hasSubmittedLiveness('usr_1')).toBe(false);
    userRepo.findByUserId.mockResolvedValue({ id: 'ukyc_1', purpose: 'LIVENESS', status: 'REJECTED', submittedAt: NOW, attestedAt: null });
    expect(await hasSubmittedLiveness('usr_1')).toBe(false);
  });

  it('answers the attestation on the case read', async () => {
    userRepo.findByUserId.mockResolvedValue({
      id: 'ukyc_1', purpose: 'LIVENESS', status: 'VERIFIED', submittedAt: null, reviewedAt: NOW, rejectionReason: null, fileId: null, selfVideoUrl: null,
      recordedById: null, attestedById: 'usr_admin', attestedAt: NOW, attestationNote: 'met in person at the Pune desk',
    });
    expect(await livenessStateFor('usr_1')).toMatchObject({
      status: 'VERIFIED',
      fileId: null,
      attestedById: 'usr_admin',
      attestedAt: NOW,
      attestationNote: 'met in person at the Pune desk',
    });
  });
});

describe('POST /user-kyc/:userId — the video the desk captured', () => {
  it('records the party’s file with the admin as the recorder, and audits it', async () => {
    uploads.findUploadedFile.mockResolvedValue({ id: 'f9', purpose: 'USER_KYC', userId: 'usr_admin', ownerUserId: 'usr_1', url: '/api/v1/files/f9' });
    const result = await submitLivenessOnBehalf('usr_1', 'f9', 'usr_admin');
    expect(userRepo.upsertLiveness).toHaveBeenCalledWith('usr_1', '/api/v1/files/f9', 'usr_admin', 'f9');
    expect(result.created).toBe(true);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'USER_KYC_LIVENESS_RECORDED_AT_DESK', expect.objectContaining({ targetType: 'UserKyc', targetId: 'ukyc_1', metadata: expect.objectContaining({ userId: 'usr_1', fileId: 'f9' }) }));
  });

  it('takes the admin’s own upload too, but never somebody else’s file or another purpose', async () => {
    uploads.findUploadedFile.mockResolvedValue({ id: 'f10', purpose: 'USER_KYC', userId: 'usr_admin', ownerUserId: null, url: '/api/v1/files/f10' });
    await expect(submitLivenessOnBehalf('usr_1', 'f10', 'usr_admin')).resolves.toBeTruthy();

    uploads.findUploadedFile.mockResolvedValue({ id: 'f11', purpose: 'USER_KYC', userId: 'usr_other', ownerUserId: 'usr_other', url: '/api/v1/files/f11' });
    await expect(submitLivenessOnBehalf('usr_1', 'f11', 'usr_admin')).rejects.toMatchObject({ statusCode: 403 });

    uploads.findUploadedFile.mockResolvedValue({ id: 'f12', purpose: 'KYC', userId: 'usr_admin', ownerUserId: 'usr_1', url: '/api/v1/files/f12' });
    await expect(submitLivenessOnBehalf('usr_1', 'f12', 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
  });
});
