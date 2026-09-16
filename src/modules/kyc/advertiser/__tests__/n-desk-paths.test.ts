import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot N (the owner, 14 Sep 2026) — the advertiser's two new KYC paths.
 *
 * KYC can be done by the party (as today), REQUESTED from the desk, or
 * RECORDED at the desk by an admin. A request stamps who asked, when and
 * over which channel, runs Digio on the advertiser's behalf for DIGIO,
 * tells the advertiser by the KYC_REQUESTED template (email, SMS, a push
 * that opens their KYC screen), and is audited; a VERIFIED record is
 * refused. The desk's `PUT /advertiser-kyc/:id` stamps who recorded it and
 * how, and is audited. The queue answers `?requested=true` — a request
 * with nothing submitted yet — and `counts.requested`; every row names
 * who requested and who recorded.
 *
 * N3-B: the record is keyed by the Advertiser PROFILE — `:id` resolves as
 * the row id, then the profile id, then the user id; writes are addressed
 * by `{ advertiserProfileId, advertiserId }`; Digio is asked with the
 * profile; the channel defaults to DIGIO.
 */

const { repository, advertisers, notifications, audit, digio, settings, labels } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findByAdvertiserId: vi.fn(),
    findByProfileId: vi.fn(),
    requestKyc: vi.fn(),
    updateById: vi.fn(),
    findPage: vi.fn(),
    countBreached: vi.fn(),
    countByState: vi.fn(),
    countEscalated: vi.fn(),
    countRequested: vi.fn(),
  },
  advertisers: { applyKycDecision: vi.fn(), applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn(), findAdvertiser: vi.fn() },
  notifications: { createNotification: vi.fn(), notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-requested', deliveries: [] })) },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  digio: { initiateAdvertiserDigioKyc: vi.fn(), restartAdvertiserDigioKyc: vi.fn(), advertiserDigioStatus: vi.fn(), handleAdvertiserDigioWebhook: vi.fn() },
  settings: { getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })), getFlow: vi.fn(async () => ({ version: 7 })), ONBOARDING_FLOW_KEY: 'onboarding' },
  labels: { kycUserLabels: vi.fn(), kycLabelFor: vi.fn(), kycCaseExtras: vi.fn() },
}));

vi.mock('../prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../../../advertisers', () => advertisers);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../advertiser-digio.service', () => digio);
vi.mock('../../../app-config', () => settings);
vi.mock('../../document-review/document-review.service', () => ({
  recordDocumentReview: vi.fn(), flagDocuments: vi.fn(), flaggedDocuments: vi.fn(), listDocumentReviews: vi.fn(), listDocumentReviewsWithReviewer: vi.fn(), clearDocumentReviews: vi.fn(),
}));
vi.mock('../../user/user-kyc.service', () => ({ hasSubmittedLiveness: vi.fn(), livenessStateFor: vi.fn() }));
vi.mock('../../escalation.service', () => ({ escalateKyc: vi.fn() }));
vi.mock('../../case-read', () => labels);

import { listAdvertiserKycs, requestAdvertiserKyc, updateAdvertiserKycById } from '../advertiser-kyc.service';
import { kycRequestSchema } from '../../kyc.schema';

const NOW = new Date('2026-09-14T09:00:00.000Z');
const row = { id: 'akyc_1', advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', status: 'PENDING', method: 'MANUAL', submittedAt: null, requestedAt: null, requestedById: null, requestedChannel: null, recordedById: null, recordedVia: null, assignedToId: null };
const profile = (id: string, userId: string | null) => ({ id, userId, name: 'Meera S', companyName: null, email: 'meera@example.com', mobile: '+919876543210', type: 'INDIVIDUAL', kycStatus: 'PENDING' });
const KEY = { advertiserProfileId: 'adv_1', advertiserId: 'usr_adv' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockImplementation(async (id: string) => (id === 'akyc_1' ? row : null));
  repository.findByAdvertiserId.mockImplementation(async (userId: string) => (userId === 'usr_adv' ? row : null));
  repository.findByProfileId.mockImplementation(async (profileId: string) => (profileId === 'adv_1' ? row : null));
  repository.requestKyc.mockImplementation(async (key: Record<string, unknown>, stamp: Record<string, unknown>) => ({ ...row, ...key, ...stamp }));
  repository.updateById.mockImplementation(async (_id: string, data: Record<string, unknown>, stamp?: Record<string, unknown>) => ({ ...row, ...data, ...(stamp ?? {}) }));
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  repository.countBreached.mockResolvedValue(0);
  repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 0, VERIFIED: 0, REJECTED: 0, NEEDS_INFO: 0 });
  repository.countEscalated.mockResolvedValue(0);
  repository.countRequested.mockResolvedValue(0);
  advertisers.getAdvertiserForUser.mockImplementation(async (userId: string) =>
    userId === 'usr_adv' ? profile('adv_1', 'usr_adv') : userId === 'usr_fresh' ? profile('adv_fresh', 'usr_fresh') : null,
  );
  advertisers.findAdvertiser.mockImplementation(async (id: string) =>
    id === 'adv_1' ? profile('adv_1', 'usr_adv') : id === 'adv_fresh' ? profile('adv_fresh', 'usr_fresh') : id === 'adv_console' ? profile('adv_console', null) : null,
  );
  digio.initiateAdvertiserDigioKyc.mockResolvedValue({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://digio/#dg_1' });
  labels.kycUserLabels.mockImplementation(async (ids: readonly (string | null | undefined)[]) => new Map(ids.filter((id): id is string => !!id).map((id) => [id, { id, name: `name of ${id}` }])));
  labels.kycLabelFor.mockImplementation((map: Map<string, { id: string; name: string | null }>, id: string | null | undefined) => (id ? map.get(id) ?? { id, name: null } : null));
});

describe('the request body', () => {
  it('takes a channel (upper-cased) and an optional note; N3-B: the channel defaults to DIGIO so the one click needs no body', () => {
    expect(kycRequestSchema.parse({ channel: 'digio' })).toEqual({ channel: 'DIGIO' });
    expect(kycRequestSchema.parse({ channel: 'MANUAL', note: 'Bring your PAN to the desk' })).toEqual({ channel: 'MANUAL', note: 'Bring your PAN to the desk' });
    expect(kycRequestSchema.safeParse({ channel: 'POST' }).success).toBe(false);
    expect(kycRequestSchema.parse({})).toEqual({ channel: 'DIGIO' });
  });
});

describe('POST /advertiser-kyc/:id/request', () => {
  it('DIGIO: initiates Digio on the advertiser’s behalf, stamps the request, tells the advertiser with the deep link, and audits', async () => {
    const result = await requestAdvertiserKyc('akyc_1', { channel: 'DIGIO', note: 'Please finish this week' }, 'usr_admin', undefined, NOW);
    expect(digio.initiateAdvertiserDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ id: 'adv_1', userId: 'usr_adv', name: 'Meera S', email: 'meera@example.com', mobile: '+919876543210' }));
    expect(repository.requestKyc).toHaveBeenCalledWith(KEY, { requestedById: 'usr_admin', requestedChannel: 'DIGIO', at: NOW });
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_REQUESTED',
      'usr_adv',
      { partyName: 'Meera S', channel: 'Digio', note: 'Please finish this week', deepLink: 'adx://kyc' },
      expect.objectContaining({ inApp: expect.objectContaining({ type: 'KYC', relatedId: 'akyc_1' }) }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'ADVERTISER_KYC_REQUESTED',
      expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_1', module: 'kyc', metadata: expect.objectContaining({ advertiserId: 'usr_adv', advertiserProfileId: 'adv_1', channel: 'DIGIO', digioKycId: 'dg_1' }) }),
    );
    expect(result).toMatchObject({ kyc: { requestedById: 'usr_admin', requestedChannel: 'DIGIO' }, digio: { kycId: 'dg_1' }, notified: true });
  });

  it('MANUAL: only stamps, tells and audits — Digio is never asked', async () => {
    const result = await requestAdvertiserKyc('akyc_1', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(digio.initiateAdvertiserDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).toHaveBeenCalledWith(KEY, { requestedById: 'usr_admin', requestedChannel: 'MANUAL', at: NOW });
    expect(notifications.notify).toHaveBeenCalledWith('KYC_REQUESTED', 'usr_adv', expect.objectContaining({ channel: 'at the ADX desk', note: '' }), expect.anything());
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_REQUESTED', expect.objectContaining({ metadata: expect.objectContaining({ channel: 'MANUAL' }) }));
    expect(result.digio).toBeNull();
  });

  it('resolves :id as the KYC row id, the profile id or the advertiser’s user id — a request before any row exists is fine', async () => {
    await requestAdvertiserKyc('usr_adv', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(repository.requestKyc).toHaveBeenLastCalledWith(KEY, expect.objectContaining({ requestedChannel: 'MANUAL' }));

    await requestAdvertiserKyc('adv_1', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(repository.requestKyc).toHaveBeenLastCalledWith(KEY, expect.objectContaining({ requestedChannel: 'MANUAL' }));

    await requestAdvertiserKyc('usr_fresh', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(repository.requestKyc).toHaveBeenLastCalledWith({ advertiserProfileId: 'adv_fresh', advertiserId: 'usr_fresh' }, expect.objectContaining({ requestedChannel: 'MANUAL' }));

    await expect(requestAdvertiserKyc('usr_nobody', { channel: 'MANUAL' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('N3-B: an advertiser created on the console with no app account — the record carries the profile alone, Digio is asked with the profile’s contact, the notice is skipped and the answer says so', async () => {
    const result = await requestAdvertiserKyc('adv_console', { channel: 'DIGIO' }, 'usr_admin', undefined, NOW);
    expect(digio.initiateAdvertiserDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ id: 'adv_console', userId: null, email: 'meera@example.com', mobile: '+919876543210' }));
    expect(repository.requestKyc).toHaveBeenCalledWith({ advertiserProfileId: 'adv_console', advertiserId: null }, expect.objectContaining({ requestedChannel: 'DIGIO' }));
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_REQUESTED', expect.objectContaining({ metadata: expect.objectContaining({ advertiserId: null, advertiserProfileId: 'adv_console' }) }));
    expect(result).toMatchObject({ kyc: { advertiserProfileId: 'adv_console', advertiserId: null }, digio: { kycId: 'dg_1' }, notified: false });
  });

  it('is refused 409 KYC_ALREADY_VERIFIED on a VERIFIED record, before anything is written or sent', async () => {
    repository.findById.mockResolvedValue({ ...row, status: 'VERIFIED' });
    await expect(requestAdvertiserKyc('akyc_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.initiateAdvertiserDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('PUT /advertiser-kyc/:id — recorded at the desk', () => {
  it('stamps who recorded it and how, keeps the status, and audits ADVERTISER_KYC_RECORDED_AT_DESK', async () => {
    const result = await updateAdvertiserKycById('akyc_1', { govIdFrontUrl: 'https://x/front.png', panNumber: 'ABCDE1234F', manifestVersion: 3 }, 'usr_admin', undefined, NOW);
    expect(repository.updateById).toHaveBeenCalledWith('akyc_1', { govIdFrontUrl: 'https://x/front.png', panNumber: 'ABCDE1234F' }, { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', at: NOW });
    expect(result).toMatchObject({ recordedById: 'usr_admin', recordedVia: 'DESK', status: 'PENDING' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'ADVERTISER_KYC_RECORDED_AT_DESK',
      expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_1', module: 'kyc', metadata: expect.objectContaining({ advertiserId: 'usr_adv', fields: ['govIdFrontUrl', 'panNumber'] }) }),
    );
    expect(audit.auditDiff).toHaveBeenCalled();
  });

  it('is 404 for a row that is not there', async () => {
    await expect(updateAdvertiserKycById('akyc_9', { selfieUrl: 'https://x/s.png' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.updateById).not.toHaveBeenCalled();
  });
});

describe('GET /advertiser-kyc — the requested facet', () => {
  it('passes ?requested=true through, counts the requested across the queue, and names who requested and who recorded on every row', async () => {
    repository.findPage.mockResolvedValue({
      items: [{ ...row, id: 'k1', requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'MANUAL', recordedById: 'usr_desk', recordedVia: 'DESK' }],
      total: 1,
    });
    repository.countRequested.mockResolvedValue(3);
    const page = await listAdvertiserKycs({ status: 'PENDING', requested: true }, 1, 20, undefined, NOW);
    expect(repository.findPage).toHaveBeenCalledWith({ status: 'PENDING', requested: true }, 1, 20, undefined);
    expect(repository.countRequested).toHaveBeenCalledWith({ status: 'PENDING', requested: true });
    expect(page.counts).toMatchObject({ escalated: 0, requested: 3 });
    expect(page.items[0]).toMatchObject({
      requestedAt: NOW,
      requestedChannel: 'MANUAL',
      recordedVia: 'DESK',
      requestedBy: { id: 'usr_admin', name: 'name of usr_admin' },
      recordedBy: { id: 'usr_desk', name: 'name of usr_desk' },
    });
  });
});
