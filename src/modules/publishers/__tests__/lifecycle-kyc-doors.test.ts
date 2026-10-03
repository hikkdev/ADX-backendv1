import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): the publisher queue rows say where the
 * account stands, and the desk's "Request KYC" and Digio restart refuse a
 * closed account (409 ACCOUNT_CLOSED) and one suspended from new work (409
 * ACCOUNT_SUSPENDED) before anything is stamped or sent.
 */

const { repository, kyc, notifications, audit, digio } = vi.hoisted(() => ({
  repository: {
    findKycDetail: vi.fn(),
    findSummaryById: vi.fn(),
    findKycQueue: vi.fn(),
    countKycQueue: vi.fn(),
    requestKyc: vi.fn(),
  },
  kyc: {
    kycUserLabels: vi.fn(async () => new Map()),
    clearDocumentReviews: vi.fn(),
    resolveManifestVersion: vi.fn(),
    listDocumentReviews: vi.fn(async () => []),
    listDocumentReviewsWithReviewer: vi.fn(async () => []),
    livenessStateFor: vi.fn(async () => null),
    kycCaseExtras: vi.fn(async () => ({})),
    flaggedDocuments: vi.fn(async () => []),
    hasSubmittedLiveness: vi.fn(),
    recordDocumentReview: vi.fn(),
    flagDocuments: vi.fn(),
    escalateKyc: vi.fn(),
    maskPan: vi.fn(),
    trimDigioPayload: vi.fn(),
  },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  digio: { initiateDigioKyc: vi.fn(), noteEntityTypeForManualRequest: vi.fn(), getDigioKycStatus: vi.fn(), handleDigioWebhook: vi.fn(), onUnmatchedDigioWebhook: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../kyc/digio.service', () => digio);
vi.mock('../../kyc', () => kyc);
vi.mock('../../notifications', () => notifications);
vi.mock('../../agents', () => ({ getAgentWithUser: vi.fn(), findAgentProfile: vi.fn(), requireAgentProfile: vi.fn(), findAgentTier: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../uploads', () => ({ purgeStoredFile: vi.fn(), fileIdFromUrl: vi.fn(() => null) }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));

import { requestKycFromDesk } from '../kyc/kyc-desk.service';
import { listKycQueue, restartDigioKyc } from '../publishers.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_pub',
  name: 'Asha Rao',
  kycStatus: 'PENDING',
  suspensionScopes: [],
  user: { isActive: true, closedAt: null },
  kyc: { id: 'kyc_1', status: 'PENDING', submittedAt: null },
  agent: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycDetail.mockResolvedValue(publisher());
  repository.countKycQueue.mockResolvedValue(0);
});

describe('the queue rows', () => {
  it('carry accountState beside the KYC state', async () => {
    repository.findKycQueue.mockResolvedValue([
      publisher({ id: 'p_active' }),
      publisher({ id: 'p_suspended', suspensionScopes: ['BLOCK_NEW'] }),
      publisher({ id: 'p_deactivated', user: { isActive: false, closedAt: null }, suspensionScopes: ['BLOCK_NEW'] }),
      publisher({ id: 'p_closed', user: { isActive: false, closedAt: new Date() } }),
      publisher({ id: 'p_heldbydesk', userId: null, user: null }),
    ]);
    const { items } = await listKycQueue({ includeInactive: true });
    expect(Object.fromEntries(items.map((item) => [item.id, item.accountState]))).toEqual({
      p_active: 'ACTIVE',
      p_suspended: 'SUSPENDED',
      p_deactivated: 'DEACTIVATED',
      p_closed: 'CLOSED',
      p_heldbydesk: 'ACTIVE',
    });
  });

  it('passes include=inactive through to every count', async () => {
    repository.findKycQueue.mockResolvedValue([]);
    await listKycQueue({ includeInactive: true });
    for (const [filter] of repository.countKycQueue.mock.calls) expect(filter).toMatchObject({ includeInactive: true });
  });
});

describe('the desk does not ask a closed or blocked account', () => {
  it('Request KYC on a closed account is 409 ACCOUNT_CLOSED, nothing stamped or started', async () => {
    repository.findKycDetail.mockResolvedValue(publisher({ user: { isActive: false, closedAt: new Date() } }));
    await expect(requestKycFromDesk('pub_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_CLOSED' });
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).not.toHaveBeenCalled();
  });

  it('Request KYC on a party suspended from new work is 409 ACCOUNT_SUSPENDED', async () => {
    repository.findKycDetail.mockResolvedValue(publisher({ suspensionScopes: ['BLOCK_NEW', 'FREEZE_WALLET'] }));
    await expect(requestKycFromDesk('pub_1', { channel: 'MANUAL' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_SUSPENDED' });
    expect(repository.requestKyc).not.toHaveBeenCalled();
  });

  it('the Digio restart refuses the same two', async () => {
    repository.findKycDetail.mockResolvedValue(publisher({ user: { isActive: false, closedAt: new Date() } }));
    await expect(restartDigioKyc('pub_1', 'usr_admin')).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' });
    repository.findKycDetail.mockResolvedValue(publisher({ suspensionScopes: ['BLOCK_NEW'] }));
    await expect(restartDigioKyc('pub_1', 'usr_admin')).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
  });
});
