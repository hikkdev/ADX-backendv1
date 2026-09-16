import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2 verifier — the last write over a VERIFIED advertiser record: the
 * party's own Digio start (`POST /advertiser-kyc/me/digio`). It re-pointed
 * the row at a fresh Digio session, and the session's webhook then wrote
 * REJECTED or PENDING over VERIFIED. Now it is 409 `KYC_ALREADY_VERIFIED`
 * before Digio is asked, like every other submit path (N2-B).
 */

const { repository, digio } = vi.hoisted(() => ({
  repository: { findById: vi.fn(), upsertDigio: vi.fn(), findByAdvertiserId: vi.fn(), findByProfileId: vi.fn(), findByDigioRequestId: vi.fn(), applyDigioWebhook: vi.fn() },
  digio: { requestDigioKyc: vi.fn() },
}));

vi.mock('../prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../advertisers', () => ({ applyKycDecision: vi.fn(), applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn(), findAdvertiser: vi.fn() }));
vi.mock('../../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../../../shared/audit', () => ({ logActivity: vi.fn() }));

import { initiateAdvertiserDigioKyc } from '../advertiser-digio.service';

// N3-B: the session is keyed by the profile.
const PROFILE = { id: 'adv_1', userId: 'usr_adv', name: 'Meera S', companyName: null, email: 'meera@example.in', mobile: '+919812340001' };

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'kyc_9', accessToken: 'tok', validTill: '2026-09-11T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#kyc_9?token=tok', mock: false });
  repository.upsertDigio.mockResolvedValue({ id: 'row_1' });
  repository.findByProfileId.mockImplementation(() => repository.findByAdvertiserId('usr_adv'));
});

describe('starting Digio on a verified advertiser', () => {
  it('is 409 KYC_ALREADY_VERIFIED before Digio is asked or the row touched', async () => {
    repository.findByAdvertiserId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'VERIFIED', method: 'MANUAL' });
    await expect(initiateAdvertiserDigioKyc(PROFILE)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.upsertDigio).not.toHaveBeenCalled();
  });

  it('still opens a session with no row, or a row that is not verified', async () => {
    repository.findByAdvertiserId.mockResolvedValue(null);
    await expect(initiateAdvertiserDigioKyc(PROFILE)).resolves.toMatchObject({ kycId: 'kyc_9' });
    repository.findByAdvertiserId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'REJECTED', method: 'DIGIO' });
    await expect(initiateAdvertiserDigioKyc(PROFILE)).resolves.toMatchObject({ kycId: 'kyc_9' });
    expect(repository.upsertDigio).toHaveBeenCalledTimes(2);
  });
});
