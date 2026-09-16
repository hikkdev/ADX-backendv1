import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * U7 — KYC by Digio, in the publisher's own hands.
 *
 * The agent path already asked Digio on a publisher's behalf. Now the
 * publisher can ask for themselves: the same request, keyed on their own
 * profile, and the same status read. A user with no publisher profile is
 * told so rather than handed somebody else's row.
 */

const { repository, digio, grants } = vi.hoisted(() => ({
  repository: {
    findByUserId: vi.fn(),
    findByUserIdWithKyc: vi.fn(),
  },
  digio: { initiateDigioKyc: vi.fn(), getDigioKycStatus: vi.fn() },
  grants: {
    accessLogFor: vi.fn(),
    openOnboardingGrant: vi.fn(),
    closeOnboardingGrants: vi.fn(),
    hasLiveOnboardingGrant: vi.fn(),
    liveGrantFor: vi.fn(),
    holdsLiveGrant: vi.fn(),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../kyc/digio.service', () => digio);
vi.mock('../../access-grants', () => grants);
vi.mock('../../qr', () => ({
  generateQr: vi.fn(),
  deactivateQr: vi.fn(),
  getQrById: vi.fn(),
  findActiveQrFor: vi.fn(),
  deactivateQrsFor: vi.fn(),
  findPendingScan: vi.fn(),
  decideOnboardingScan: vi.fn(),
  ONBOARDING_QR_TTL_SECONDS: 90,
  registerPublisherOnboardingPort: vi.fn(),
}));
vi.mock('../../agents', () => ({ getAgentWithUser: vi.fn(), findAgentProfile: vi.fn(), requireAgentProfile: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));

import { getMyAccessLog, initiateMyDigioKyc, myDigioKycStatus } from '../onboarding/publisher-onboarding.service';

const publisher = { id: 'pub_1', userId: 'usr_1', name: 'Asha Rao', email: null, mobile: '+919876543210' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByUserId.mockResolvedValue(publisher);
  digio.initiateDigioKyc.mockResolvedValue({ kycId: 'kyc_1', accessToken: 'tok', validTill: '2026-09-11T00:00:00.000Z', sdkUrl: 'https://digio/#kyc_1?token=tok' });
  digio.getDigioKycStatus.mockResolvedValue({ method: 'DIGIO', digioStatus: 'pending', kycStatus: 'PENDING', digioVerifiedAt: null });
  grants.accessLogFor.mockResolvedValue({ scans: [], grants: [], changes: [] });
});

describe('Digio, chosen by the publisher', () => {
  it('asks Digio with the caller\\u2019s own identity', async () => {
    const started = await initiateMyDigioKyc('usr_1');
    expect(digio.initiateDigioKyc).toHaveBeenCalledWith('pub_1', 'Asha Rao', '', '+919876543210');
    expect(started.sdkUrl).toBe('https://digio/#kyc_1?token=tok');
  });

  it('reads the caller\\u2019s own status', async () => {
    const status = await myDigioKycStatus('usr_1');
    expect(digio.getDigioKycStatus).toHaveBeenCalledWith('pub_1');
    expect(status).toMatchObject({ digioStatus: 'pending' });
  });

  it('refuses a user with no publisher profile', async () => {
    repository.findByUserId.mockResolvedValue(null);
    await expect(initiateMyDigioKyc('usr_x')).rejects.toMatchObject({ statusCode: 404 });
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
  });
});

describe('the access log, from the owner\\u2019s side', () => {
  it('is composed for the caller\\u2019s own publisher', async () => {
    await getMyAccessLog('usr_1');
    expect(grants.accessLogFor).toHaveBeenCalledWith({ publisherId: 'pub_1' });
  });
});
