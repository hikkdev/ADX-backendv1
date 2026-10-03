import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * U7, demand side — KYC by Digio for an advertiser.
 *
 * What is pinned: initiating records the request on the advertiser's own
 * row — N3-B: keyed by the Advertiser PROFILE, the user id riding along, the
 * profile's contact being the customer Digio reaches, so an advertiser with
 * no app account can be asked; the status read is that row; a webhook whose
 * id is an advertiser's is claimed, applied, flips the booking gate the way
 * a manual review does, and tells the advertiser; one that is not is left
 * for whoever else registered.
 */

const { repository, digio, advertisers, notifications, audit } = vi.hoisted(() => ({
  audit: { logActivity: vi.fn(), auditDiff: (before: Record<string, unknown>, after: Record<string, unknown>) => ({ before, after }) },
  repository: {
    findById: vi.fn(),
    upsertDigio: vi.fn(),
    reopenDigioForUpgrade: vi.fn(),
    findByAdvertiserId: vi.fn(),
    findByProfileId: vi.fn(),
    findByDigioRequestId: vi.fn(),
    applyDigioWebhook: vi.fn(),
  },
  digio: { requestDigioKyc: vi.fn() },
  advertisers: { applyKycDecision: vi.fn(), applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn(), findAdvertiser: vi.fn(), setAdvertiserEntityType: vi.fn() },
  notifications: { createNotification: vi.fn() },
}));

// Phase D: the legal form picks the Digio workflow — an INDIVIDUAL's is settled by the legacy type.
const PROFILE = { id: 'adv_1', userId: 'usr_adv', name: 'Meera S', companyName: null, email: 'meera@example.in', mobile: '+919812340001', type: 'INDIVIDUAL', entityType: null, kycStatus: 'PENDING' } as const;
const BY = { byUserId: 'usr_adv' };
const KEY = { advertiserProfileId: 'adv_1', advertiserId: 'usr_adv' };

vi.mock('../prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../advertisers', () => advertisers);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);

import { advertiserDigioStatus, handleAdvertiserDigioWebhook, initiateAdvertiserDigioKyc, noteEntityTypeForManualRequest, restartAdvertiserDigioKyc } from '../advertiser-digio.service';

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'kyc_9', accessToken: 'tok', validTill: '2026-09-11T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#kyc_9?token=tok', mock: false });
  repository.upsertDigio.mockResolvedValue({ id: 'row_1' });
  repository.findByAdvertiserId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', method: 'DIGIO', digioStatus: 'pending', status: 'PENDING', digioVerifiedAt: null });
  repository.findByProfileId.mockImplementation(() => repository.findByAdvertiserId('usr_adv'));
  repository.findByDigioRequestId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'PENDING' });
  repository.applyDigioWebhook.mockResolvedValue({ id: 'row_1' });
  advertisers.getAdvertiserForUser.mockResolvedValue(PROFILE);
  advertisers.findAdvertiser.mockResolvedValue(PROFILE);
});

describe('initiating', () => {
  it('asks Digio with a reference of its own (the profile’s) and records the request on the advertiser’s row, keyed by the profile', async () => {
    const session = await initiateAdvertiserDigioKyc(PROFILE, BY);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ party: 'ADVERTISER', workflowKey: 'ADVERTISER.INDIVIDUAL', customerName: 'Meera S', customerEmail: 'meera@example.in', customerMobile: '+919812340001', referenceId: expect.stringMatching(/^adx-adv-adv_1-/) }));
    expect(repository.upsertDigio).toHaveBeenCalledWith(KEY, expect.objectContaining({ method: 'DIGIO', digioRequestId: 'kyc_9', digioStatus: 'pending' }));
    expect(session).toMatchObject({ kycId: 'kyc_9', sdkUrl: 'https://app.digio.in/#kyc_9?token=tok' });
  });

  it('N3-B: an advertiser with no app account is asked with the profile’s contact, the record carrying the profile alone', async () => {
    repository.findByProfileId.mockResolvedValue(null);
    await initiateAdvertiserDigioKyc({ ...PROFILE, id: 'adv_console', userId: null, companyName: 'Swiggy' }, { byUserId: 'usr_admin' });
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ customerName: 'Swiggy', customerEmail: 'meera@example.in', customerMobile: '+919812340001', referenceId: expect.stringMatching(/^adx-adv-adv_console-/) }));
    expect(repository.upsertDigio).toHaveBeenCalledWith({ advertiserProfileId: 'adv_console', advertiserId: null }, expect.objectContaining({ digioRequestId: 'kyc_9' }));
  });

  it('reads the status off the row — through the caller’s profile — or null before one exists', async () => {
    expect(await advertiserDigioStatus('usr_adv')).toEqual({ method: 'DIGIO', digioStatus: 'pending', kycStatus: 'PENDING', digioVerifiedAt: null });
    expect(repository.findByProfileId).toHaveBeenCalledWith('adv_1');
    repository.findByAdvertiserId.mockResolvedValue(null);
    expect(await advertiserDigioStatus('usr_x')).toBeNull();
  });
});

describe('Phase D: the legal form at the start', () => {
  const COMMERCIAL = { ...PROFILE, type: 'COMMERCIAL', companyName: 'Aster Home Pvt Ltd' } as const;

  it('is 409 ENTITY_TYPE_REQUIRED with the options when the form is unknown and none was sent — nothing stored, Digio not asked', async () => {
    await expect(initiateAdvertiserDigioKyc(COMMERCIAL, BY)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ENTITY_TYPE_REQUIRED',
      details: { party: 'ADVERTISER', options: expect.arrayContaining([{ value: 'COMPANY', label: 'Company' }]) },
    });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(advertisers.setAdvertiserEntityType).not.toHaveBeenCalled();
    expect(repository.upsertDigio).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('stores the sent form and audits it, then asks Digio on that workflow — political advertisers have their own', async () => {
    await initiateAdvertiserDigioKyc(COMMERCIAL, { byUserId: 'usr_adv', entityType: 'LLP_PARTNERSHIP' });
    expect(advertisers.setAdvertiserEntityType).toHaveBeenCalledWith('adv_1', 'LLP_PARTNERSHIP');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_adv', 'KYC_ENTITY_TYPE_SET', expect.objectContaining({ targetType: 'Advertiser', targetId: 'adv_1', diff: { before: { entityType: null }, after: { entityType: 'LLP_PARTNERSHIP' } } }));
    expect(digio.requestDigioKyc).toHaveBeenLastCalledWith(expect.objectContaining({ workflowKey: 'ADVERTISER.LLP_PARTNERSHIP' }));

    await initiateAdvertiserDigioKyc(COMMERCIAL, { byUserId: 'usr_adv', entityType: 'POLITICAL' });
    expect(digio.requestDigioKyc).toHaveBeenLastCalledWith(expect.objectContaining({ workflowKey: 'ADVERTISER.POLITICAL' }));
  });

  it('the upgrade: a verified individual verifying as a company reopens the record and the mirror on the new request', async () => {
    repository.findByProfileId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'VERIFIED', digioRequestId: 'kyc_old', digioPayload: { id: 'kyc_old', status: 'approved', kyc_documents: [{ type: 'PAN', status: 'approved', id_number: 'ABCDE1234F' }] } });
    await initiateAdvertiserDigioKyc({ ...PROFILE, kycStatus: 'VERIFIED' }, { byUserId: 'usr_admin', entityType: 'COMPANY' });
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'ADVERTISER.COMPANY' }));
    expect(repository.reopenDigioForUpgrade).toHaveBeenCalledWith(KEY, expect.objectContaining({ digioRequestId: 'kyc_9', digioStatus: 'pending' }));
    expect(repository.upsertDigio).not.toHaveBeenCalled();
    expect(advertisers.setAdvertiserEntityType).toHaveBeenCalledWith('adv_1', 'COMPANY');
    expect(advertisers.applyKycDecision).toHaveBeenCalledWith('adv_1', 'PENDING');
    const upgraded = audit.logActivity.mock.calls.find((call) => call[1] === 'KYC_ENTITY_UPGRADED') as [string, string, { diff: { before: Record<string, unknown>; after: Record<string, unknown> } }];
    expect(upgraded[2].diff.before).toMatchObject({ entityType: 'INDIVIDUAL', status: 'VERIFIED', digioRequestId: 'kyc_old', digioPayload: { id: 'kyc_old', trimmed: true } });
    expect(upgraded[2].diff.after).toMatchObject({ entityType: 'COMPANY', status: 'PENDING', digioRequestId: 'kyc_9' });
    expect(JSON.stringify(upgraded[2].diff)).not.toContain('ABCDE1234F');
  });

  it('a refused upgrade leaves the verified individual as they were; any other change on a verified advertiser is 409', async () => {
    repository.findByProfileId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'VERIFIED' });
    digio.requestDigioKyc.mockRejectedValueOnce(Object.assign(new Error('refused'), { statusCode: 502, code: 'KYC_PROVIDER_REFUSED' }));
    await expect(initiateAdvertiserDigioKyc({ ...PROFILE, kycStatus: 'VERIFIED' }, { ...BY, entityType: 'COMPANY' })).rejects.toMatchObject({ statusCode: 502 });
    expect(repository.reopenDigioForUpgrade).not.toHaveBeenCalled();
    expect(advertisers.applyKycDecision).not.toHaveBeenCalled();

    await expect(initiateAdvertiserDigioKyc({ ...PROFILE, entityType: 'COMPANY', kycStatus: 'VERIFIED' }, { ...BY, entityType: 'NON_PROFIT' })).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).toHaveBeenCalledTimes(1);
  });

  it('a manual desk request stores a sent form and asks nothing when none is sent', async () => {
    await noteEntityTypeForManualRequest(COMMERCIAL, { byUserId: 'usr_admin' });
    expect(advertisers.setAdvertiserEntityType).not.toHaveBeenCalled();
    await noteEntityTypeForManualRequest(COMMERCIAL, { byUserId: 'usr_admin', entityType: 'COMPANY' });
    expect(advertisers.setAdvertiserEntityType).toHaveBeenCalledWith('adv_1', 'COMPANY');
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
  });
});

describe('the webhook', () => {
  it('claims an advertiser’s request id, applies the answer, flips the gate and tells them', async () => {
    const claimed = await handleAdvertiserDigioWebhook({ id: 'kyc_9', customer_identifier: 'meera@example.in', status: 'approved', completed_at: '2026-09-10T10:00:00.000Z' });
    expect(claimed).toBe(true);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('row_1', expect.objectContaining({ status: 'VERIFIED', digioStatus: 'approved', digioVerifiedAt: new Date('2026-09-10T10:00:00.000Z') }));
    // N3-B: the gate flips by the profile the record names.
    expect(advertisers.applyKycDecision).toHaveBeenCalledWith('adv_1', 'VERIFIED');
    expect(advertisers.applyKycDecisionByUserId).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', type: 'KYC', title: 'Identity verified' }));
  });

  it('N3-B: a legacy row with no profile key still flips the gate by its user; a record with no user is applied and the notice skipped', async () => {
    repository.findByDigioRequestId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: null });
    await handleAdvertiserDigioWebhook({ id: 'kyc_9', customer_identifier: 'x', status: 'approved' });
    expect(advertisers.applyKycDecisionByUserId).toHaveBeenCalledWith('usr_adv', 'VERIFIED');

    vi.clearAllMocks();
    repository.findByDigioRequestId.mockResolvedValue({ id: 'row_1', advertiserId: null, advertiserProfileId: 'adv_console' });
    repository.applyDigioWebhook.mockResolvedValue({ id: 'row_1' });
    expect(await handleAdvertiserDigioWebhook({ id: 'kyc_9', customer_identifier: 'x', status: 'approved' })).toBe(true);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('row_1', expect.objectContaining({ status: 'VERIFIED' }));
    expect(advertisers.applyKycDecision).toHaveBeenCalledWith('adv_console', 'VERIFIED');
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('records a rejection with its reason, and leaves a pending update off the gate', async () => {
    await handleAdvertiserDigioWebhook({ id: 'kyc_9', customer_identifier: 'x', status: 'rejected', message: 'Face mismatch' });
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('row_1', expect.objectContaining({ status: 'REJECTED', rejectionReason: 'Face mismatch' }));
    expect(advertisers.applyKycDecision).toHaveBeenCalledWith('adv_1', 'REJECTED');

    vi.clearAllMocks();
    repository.findByDigioRequestId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'PENDING' });
    await handleAdvertiserDigioWebhook({ id: 'kyc_9', customer_identifier: 'x', status: 'pending' });
    expect(advertisers.applyKycDecision).not.toHaveBeenCalled();
    expect(advertisers.applyKycDecisionByUserId).not.toHaveBeenCalled();
  });

  it('Phase D: a pending or unknown status never moves a VERIFIED or REJECTED record back; on a PENDING one it is kept raw', async () => {
    for (const status of ['VERIFIED', 'REJECTED']) {
      repository.findByDigioRequestId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status });
      for (const sent of ['pending', 'cancelled', 'approval_pending']) {
        expect(await handleAdvertiserDigioWebhook({ id: 'kyc_9', status: sent })).toBe(true);
      }
    }
    expect(repository.applyDigioWebhook).not.toHaveBeenCalled();
    expect(advertisers.applyKycDecision).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();

    repository.findByDigioRequestId.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'PENDING' });
    await handleAdvertiserDigioWebhook({ id: 'kyc_9', status: 'approval_pending' });
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('row_1', expect.objectContaining({ digioStatus: 'approval_pending', status: 'PENDING' }));
  });

  it('leaves a request id that is not an advertiser’s to whoever else registered', async () => {
    repository.findByDigioRequestId.mockResolvedValue(null);
    expect(await handleAdvertiserDigioWebhook({ id: 'kyc_pub', customer_identifier: 'x', status: 'approved' })).toBe(false);
    expect(repository.applyDigioWebhook).not.toHaveBeenCalled();
  });
});

describe('restarted from the desk', () => {
  beforeEach(() => {
    repository.findById.mockResolvedValue({ id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'PENDING', method: 'DIGIO', digioStatus: 'rejected' });
  });

  it('asks Digio again on the row the queue lists (by the profile it names), logs who asked, and tells the advertiser', async () => {
    const result = await restartAdvertiserDigioKyc('row_1', 'usr_admin');
    expect(advertisers.findAdvertiser).toHaveBeenCalledWith('adv_1');
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'ADVERTISER.INDIVIDUAL', customerName: 'Meera S', customerMobile: '+919812340001' }));
    expect(repository.upsertDigio).toHaveBeenCalledWith(KEY, expect.objectContaining({ digioRequestId: 'kyc_9', digioStatus: 'pending' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_DIGIO_RESTARTED', undefined, expect.objectContaining({ advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', kycRowId: 'row_1', kycId: 'kyc_9' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: 'Finish your Digio check' }));
    expect(result).toMatchObject({ kycId: 'kyc_9', digioStatus: 'pending', notified: true });
  });

  it('has nothing to restart for a verified advertiser, and 404s a row that is not there', async () => {
    repository.findById.mockResolvedValueOnce({ id: 'row_1', advertiserId: 'usr_adv', status: 'VERIFIED' });
    await expect(restartAdvertiserDigioKyc('row_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findById.mockResolvedValueOnce(null);
    await expect(restartAdvertiserDigioKyc('row_9', 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
  });

  it('Phase D: restarts a verified individual only as the upgrade to a business form', async () => {
    const verifiedRow = { id: 'row_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'VERIFIED' };
    repository.findById.mockResolvedValue(verifiedRow);
    repository.findByProfileId.mockResolvedValue(verifiedRow);
    advertisers.findAdvertiser.mockResolvedValue({ ...PROFILE, kycStatus: 'VERIFIED' });
    await expect(restartAdvertiserDigioKyc('row_1', 'usr_admin', undefined, { entityType: 'INDIVIDUAL' })).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    await restartAdvertiserDigioKyc('row_1', 'usr_admin', undefined, { entityType: 'SOLE_PROPRIETOR' });
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'ADVERTISER.SOLE_PROPRIETOR' }));
    expect(repository.reopenDigioForUpgrade).toHaveBeenCalled();
  });
});
