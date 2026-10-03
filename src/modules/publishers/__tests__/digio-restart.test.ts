import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Digio case, operated from the desk.
 *
 * Ops could see a publisher's Digio state and override it by hand; they
 * could not operate it. Now the desk restarts the check: the same session
 * the publisher's phone asks for, on their own row, who asked recorded, and
 * the publisher told to open the app. A verified publisher has nothing to
 * restart, and a publisher with no app account is restarted without a nudge.
 */

const { repository, digio, notifications, audit } = vi.hoisted(() => ({
  repository: { findKycDetail: vi.fn() },
  digio: { initiateDigioKyc: vi.fn() },
  notifications: { createNotification: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../kyc/digio.service', () => digio);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));

import { restartDigioKyc } from '../publishers.service';

const publisher = { id: 'pub_1', userId: 'usr_1', name: 'Asha Rao', email: null, mobile: '+919876543210', kycStatus: 'PENDING' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycDetail.mockResolvedValue(publisher);
  digio.initiateDigioKyc.mockResolvedValue({ kycId: 'kyc_2', accessToken: 'tok', validTill: '2026-09-11T00:00:00.000Z', sdkUrl: 'https://digio/#kyc_2?token=tok' });
});

describe('restarting a Digio check from the desk', () => {
  it('asks Digio with the publisher’s own identity, records who asked, and nudges the publisher', async () => {
    const result = await restartDigioKyc('pub_1', 'usr_admin');
    // Phase D: the publisher row goes in — its entity type picks the workflow.
    expect(digio.initiateDigioKyc).toHaveBeenCalledWith(publisher, { byUserId: 'usr_admin', entityType: undefined, req: undefined });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_DIGIO_RESTARTED', undefined, { publisherId: 'pub_1', kycId: 'kyc_2' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_1', type: 'KYC', title: 'Finish your Digio check', relatedId: 'pub_1' }));
    expect(result).toEqual({ kycId: 'kyc_2', validTill: '2026-09-11T00:00:00.000Z', digioStatus: 'pending', notified: true });
  });

  it('restarts without a nudge when the publisher has no app account', async () => {
    repository.findKycDetail.mockResolvedValue({ ...publisher, userId: null });
    const result = await restartDigioKyc('pub_1', 'usr_admin');
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(result.notified).toBe(false);
  });

  it('has nothing to restart once verified, and 404s a publisher that is not there', async () => {
    repository.findKycDetail.mockResolvedValueOnce({ ...publisher, kycStatus: 'VERIFIED' });
    await expect(restartDigioKyc('pub_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findKycDetail.mockResolvedValueOnce(null);
    await expect(restartDigioKyc('pub_9', 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
  });

  it('Phase D: restarts a verified individual only as the upgrade to a business form', async () => {
    const verified = { ...publisher, kycStatus: 'VERIFIED', type: 'INDIVIDUAL', entityType: null };
    repository.findKycDetail.mockResolvedValue(verified);
    await restartDigioKyc('pub_1', 'usr_admin', undefined, { entityType: 'COMPANY' });
    expect(digio.initiateDigioKyc).toHaveBeenCalledWith(verified, { byUserId: 'usr_admin', entityType: 'COMPANY', req: undefined });

    vi.clearAllMocks();
    await expect(restartDigioKyc('pub_1', 'usr_admin', undefined, { entityType: 'INDIVIDUAL' })).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    repository.findKycDetail.mockResolvedValue({ ...verified, entityType: 'COMPANY' });
    await expect(restartDigioKyc('pub_1', 'usr_admin', undefined, { entityType: 'LLP_PARTNERSHIP' })).rejects.toMatchObject({ statusCode: 409 });
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
  });
});
