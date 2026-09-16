import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q127) — what a purge keeps, and the three sweeps.
 *
 * What is pinned: the PAN keeps its last four; the Digio payload keeps the
 * decision and its timing and nothing a document said; the cutoff is thirty
 * days; the advertiser sweep removes the private files behind `/files/:id`
 * URLs, leaves a legacy public URL's file alone (nothing to remove by id),
 * writes the masked PAN and trimmed payload, and audits KYC_IMAGES_PURGED
 * against the record; the liveness sweep drops the video and keeps the row.
 */

const { advertiserRepo, userRepo, uploads, audit } = vi.hoisted(() => ({
  advertiserRepo: { findPurgeable: vi.fn(), purgeImages: vi.fn() },
  userRepo: { findPurgeable: vi.fn(), purgeVideo: vi.fn(), findByUserId: vi.fn() },
  uploads: { purgeStoredFile: vi.fn(), findUploadedFile: vi.fn(), fileIdFromUrl: (url: string | null) => (url ? (/\/files\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null) },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../advertiser/prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: advertiserRepo }));
vi.mock('../user/prisma-user-kyc.repository', () => ({ prismaUserKycRepository: userRepo }));
vi.mock('../../uploads', () => uploads);
vi.mock('../../../shared/audit', () => audit);

import { PURGE_AFTER_DAYS, maskPan, purgeCutoff, trimDigioPayload } from '../purge.rules';
import { purgeVerifiedAdvertiserImages } from '../advertiser/advertiser-kyc-purge.service';
import { purgeVerifiedLivenessVideos } from '../user/user-kyc.service';

beforeEach(() => {
  vi.clearAllMocks();
  advertiserRepo.purgeImages.mockResolvedValue({});
  userRepo.purgeVideo.mockResolvedValue({});
});

describe('the rules', () => {
  it('keeps the last four of the PAN, the decision of the payload, and counts thirty days', () => {
    expect(maskPan('ABCDE1234F')).toBe('******234F');
    expect(maskPan(null)).toBeNull();
    expect(
      trimDigioPayload({
        id: 'kyc_1',
        status: 'approved',
        completed_at: '2026-08-01T00:00:00Z',
        kyc_documents: [{ type: 'aadhaar', status: 'approved', name: 'Asha Rao', dob: '1990-01-01', id_number: '1234 5678 9012' }],
      }),
    ).toEqual({ id: 'kyc_1', status: 'approved', completed_at: '2026-08-01T00:00:00Z', kyc_documents: [{ type: 'aadhaar', status: 'approved' }], trimmed: true });
    expect(trimDigioPayload('garbage')).toBeNull();
    expect(PURGE_AFTER_DAYS).toBe(30);
    expect(purgeCutoff(new Date('2026-09-12T00:00:00Z')).toISOString()).toBe('2026-08-13T00:00:00.000Z');
  });
});

describe('the advertiser sweep', () => {
  it('removes the private files, masks and trims, stamps and audits', async () => {
    advertiserRepo.findPurgeable.mockResolvedValue([
      {
        id: 'akyc_1',
        advertiserId: 'usr_adv',
        method: 'DIGIO',
        digioVerifiedAt: new Date('2026-08-01T00:00:00Z'),
        panNumber: 'ABCDE1234F',
        govIdFrontUrl: 'http://api/api/v1/files/f1',
        selfieUrl: 'https://cdn.example/legacy/selfie.png',
        digioPayload: { id: 'kyc_1', status: 'approved', kyc_documents: [{ type: 'pan', status: 'approved', id_number: 'ABCDE1234F' }] },
      },
    ]);
    const cutoff = new Date('2026-08-13T00:00:00Z');
    await expect(purgeVerifiedAdvertiserImages(cutoff, 'usr_admin')).resolves.toEqual(['akyc_1']);
    expect(advertiserRepo.findPurgeable).toHaveBeenCalledWith(cutoff, 200);
    expect(uploads.purgeStoredFile).toHaveBeenCalledTimes(1);
    expect(uploads.purgeStoredFile).toHaveBeenCalledWith('f1');
    expect(advertiserRepo.purgeImages).toHaveBeenCalledWith('akyc_1', {
      panNumber: '******234F',
      digioPayload: { id: 'kyc_1', status: 'approved', completed_at: null, kyc_documents: [{ type: 'pan', status: 'approved' }], trimmed: true },
    });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'KYC_IMAGES_PURGED', expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_1' }));
  });
});

describe('the liveness sweep', () => {
  it('drops the video and the file, keeps the row, reports what went', async () => {
    userRepo.findPurgeable.mockResolvedValue([{ id: 'ukyc_1', userId: 'usr_1', selfVideoUrl: '/api/v1/files/v1' }, { id: 'ukyc_2', userId: 'usr_2', selfVideoUrl: 'https://cdn/old.mp4' }]);
    await expect(purgeVerifiedLivenessVideos(new Date('2026-08-13T00:00:00Z'))).resolves.toEqual([
      { userKycId: 'ukyc_1', userId: 'usr_1' },
      { userKycId: 'ukyc_2', userId: 'usr_2' },
    ]);
    expect(userRepo.findPurgeable).toHaveBeenCalledWith('LIVENESS', expect.any(Date), 200);
    expect(uploads.purgeStoredFile).toHaveBeenCalledTimes(1);
    expect(uploads.purgeStoredFile).toHaveBeenCalledWith('v1');
    expect(userRepo.purgeVideo).toHaveBeenCalledTimes(2);
  });
});
