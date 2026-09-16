import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6: `UserKyc.fileId` (Lot E column) is written when the liveness video is
 * named and read back on the case, ahead of the URL parse that predates it.
 */

const { userRepo, uploads } = vi.hoisted(() => ({
  userRepo: { upsertLiveness: vi.fn(), findByUserId: vi.fn() },
  uploads: {
    purgeStoredFile: vi.fn(),
    findUploadedFile: vi.fn(),
    fileIdFromUrl: (url: string | null) => (url ? (/\/files\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null),
  },
}));

vi.mock('../user/prisma-user-kyc.repository', () => ({ prismaUserKycRepository: userRepo }));
vi.mock('../../uploads', () => uploads);

import { livenessStateFor, submitLiveness } from '../user/user-kyc.service';

beforeEach(() => {
  vi.clearAllMocks();
  userRepo.upsertLiveness.mockResolvedValue({ kyc: { id: 'ukyc_1' }, created: true });
});

describe('POST /user-kyc/me', () => {
  it('stores the file id on the row beside the URL', async () => {
    uploads.findUploadedFile.mockResolvedValue({ id: 'f9', purpose: 'USER_KYC', userId: 'usr_1', ownerUserId: null, url: '/api/v1/files/f9' });
    await submitLiveness('usr_1', 'f9');
    expect(userRepo.upsertLiveness).toHaveBeenCalledWith('usr_1', '/api/v1/files/f9', 'usr_1', 'f9');
  });
});

describe('the case read', () => {
  it('prefers the column and falls back to the URL for rows written before it', async () => {
    userRepo.findByUserId.mockResolvedValue({ id: 'ukyc_1', purpose: 'LIVENESS', status: 'PENDING', fileId: 'f9', selfVideoUrl: '/api/v1/files/other' });
    expect((await livenessStateFor('usr_1'))?.fileId).toBe('f9');
    userRepo.findByUserId.mockResolvedValue({ id: 'ukyc_1', purpose: 'LIVENESS', status: 'PENDING', fileId: null, selfVideoUrl: '/api/v1/files/legacy' });
    expect((await livenessStateFor('usr_1'))?.fileId).toBe('legacy');
  });
});
