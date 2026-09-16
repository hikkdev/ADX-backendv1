import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot N (the owner, 14 Sep 2026) — the publisher's two new KYC paths.
 *
 * KYC can be done by the party or their agent (as today), REQUESTED from
 * the desk, or RECORDED at the desk by an admin. A request stamps who
 * asked, when and over which channel; DIGIO opens a Digio session on the
 * publisher's behalf (the link reaches them as the integration sends it),
 * MANUAL only tells them; either way `KYC_REQUESTED` leaves (email, SMS, a
 * push that opens their KYC screen) and `PUBLISHER_KYC_REQUESTED` is
 * audited; a VERIFIED record is refused. A desk recording is the agent's
 * on-behalf body, stamped `recordedVia` DESK by the admin, PENDING with a
 * fresh `submittedAt`, method MANUAL, audited
 * `PUBLISHER_KYC_RECORDED_AT_DESK`. The queue answers `?requested=true` —
 * a request with nothing submitted yet — and `counts.requested`; every row
 * names who requested and who recorded.
 */

const { repository, kyc, notifications, audit, agents, digio } = vi.hoisted(() => ({
  repository: {
    findKycDetail: vi.fn(),
    findSummaryById: vi.fn(),
    findKycQueue: vi.fn(),
    countKycQueue: vi.fn(),
    requestKyc: vi.fn(),
    submitKyc: vi.fn(),
    pinKycManifestVersion: vi.fn(),
  },
  kyc: {
    kycUserLabels: vi.fn(async (ids: readonly (string | null | undefined)[]) =>
      new Map(ids.filter((id): id is string => !!id).map((id) => [id, { id, name: `name of ${id}` }])),
    ),
    clearDocumentReviews: vi.fn(),
    resolveManifestVersion: vi.fn(async (sent: number | undefined) => sent ?? 7),
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
  notifications: { createNotification: vi.fn(), notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-requested', deliveries: [] })) },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  agents: { getAgentWithUser: vi.fn(), findAgentProfile: vi.fn(), requireAgentProfile: vi.fn(), findAgentTier: vi.fn() },
  digio: { initiateDigioKyc: vi.fn(), getDigioKycStatus: vi.fn(), handleDigioWebhook: vi.fn(), onUnmatchedDigioWebhook: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../kyc/digio.service', () => digio);
vi.mock('../../kyc', () => kyc);
vi.mock('../../notifications', () => notifications);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../uploads', () => ({ purgeStoredFile: vi.fn(), fileIdFromUrl: vi.fn(() => null) }));
vi.mock('../../access-grants', () => ({ liveGrantFor: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })) }));

import { recordKycAtDesk, requestKycFromDesk } from '../kyc/kyc-desk.service';
import { listKycQueue } from '../publishers.service';
import { kycQueueQuerySchema } from '../publishers.schema';

const NOW = new Date('2026-09-14T09:00:00.000Z');
const publisher = {
  id: 'pub_1',
  userId: 'usr_pub',
  agentId: null,
  name: 'Asha Rao',
  email: 'asha@example.com',
  mobile: '+919876543210',
  kycStatus: 'PENDING',
  kyc: { id: 'kyc_1', publisherId: 'pub_1', status: 'PENDING', method: 'MANUAL', submittedAt: null, requestedAt: null, requestedById: null, requestedChannel: null, recordedById: null, recordedVia: null, assignedToId: null },
  agent: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycDetail.mockResolvedValue(publisher);
  repository.findSummaryById.mockResolvedValue(publisher);
  repository.findKycQueue.mockResolvedValue([]);
  repository.countKycQueue.mockResolvedValue(0);
  repository.requestKyc.mockImplementation(async (_id: string, stamp: Record<string, unknown>) => ({ ...publisher.kyc, ...stamp }));
  repository.submitKyc.mockImplementation(async (_id: string, docs: Record<string, unknown>, stamp?: Record<string, unknown>) => ({
    ...publisher.kyc,
    ...docs,
    ...(stamp ?? {}),
    status: 'PENDING',
    submittedAt: NOW,
  }));
  digio.initiateDigioKyc.mockResolvedValue({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://digio/#dg_1' });
});

describe('the queue query', () => {
  it('takes requested=true|false, coerced', () => {
    expect(kycQueueQuerySchema.parse({ requested: 'true' })).toEqual({ requested: true });
    expect(kycQueueQuerySchema.parse({ requested: 'false' })).toEqual({ requested: false });
    expect(kycQueueQuerySchema.safeParse({ requested: 'maybe' }).success).toBe(false);
  });
});

describe('POST /publishers/kyc-queue/:publisherId/request', () => {
  it('DIGIO: initiates Digio on the publisher’s behalf, stamps the request, tells the publisher with the deep link, and audits', async () => {
    const result = await requestKycFromDesk('pub_1', { channel: 'DIGIO', note: 'Please finish this week' }, 'usr_admin', undefined, NOW);
    expect(digio.initiateDigioKyc).toHaveBeenCalledWith('pub_1', 'Asha Rao', 'asha@example.com', '+919876543210');
    expect(repository.requestKyc).toHaveBeenCalledWith('pub_1', { requestedById: 'usr_admin', requestedChannel: 'DIGIO', at: NOW });
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_REQUESTED',
      'usr_pub',
      { partyName: 'Asha Rao', channel: 'Digio', note: 'Please finish this week', deepLink: 'adx://kyc' },
      expect.objectContaining({ inApp: expect.objectContaining({ type: 'KYC', relatedId: 'pub_1', relatedType: 'PUBLISHER' }) }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'PUBLISHER_KYC_REQUESTED',
      expect.objectContaining({ targetType: 'Publisher', targetId: 'pub_1', module: 'publishers', metadata: expect.objectContaining({ kycId: 'kyc_1', channel: 'DIGIO', digioKycId: 'dg_1' }) }),
    );
    expect(result).toMatchObject({ kyc: { requestedById: 'usr_admin', requestedChannel: 'DIGIO' }, digio: { kycId: 'dg_1' }, notified: true });
  });

  it('MANUAL: only stamps, tells and audits — Digio is never asked', async () => {
    const result = await requestKycFromDesk('pub_1', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).toHaveBeenCalledWith('pub_1', { requestedById: 'usr_admin', requestedChannel: 'MANUAL', at: NOW });
    expect(notifications.notify).toHaveBeenCalledWith('KYC_REQUESTED', 'usr_pub', expect.objectContaining({ channel: 'at the ADX desk', note: '' }), expect.anything());
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_REQUESTED', expect.objectContaining({ metadata: expect.objectContaining({ channel: 'MANUAL' }) }));
    expect(result.digio).toBeNull();
  });

  it('stamps and audits without a notice when the publisher has no app account yet', async () => {
    repository.findKycDetail.mockResolvedValue({ ...publisher, userId: null });
    const result = await requestKycFromDesk('pub_1', { channel: 'MANUAL' }, 'usr_admin', undefined, NOW);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(repository.requestKyc).toHaveBeenCalled();
    expect(result.notified).toBe(false);
  });

  it('is refused 409 KYC_ALREADY_VERIFIED on a VERIFIED record, before anything is written or sent; 404 for no publisher', async () => {
    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: { ...publisher.kyc, status: 'VERIFIED' } });
    await expect(requestKycFromDesk('pub_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    repository.findKycDetail.mockResolvedValue(null);
    await expect(requestKycFromDesk('pub_9', { channel: 'MANUAL' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('PUT /publishers/kyc-queue/:publisherId — recorded at the desk', () => {
  it('writes the agent’s body with the admin as the recorder, DESK, MANUAL, PENDING with a fresh submittedAt, pins the manifest, clears the tiles sent, audits', async () => {
    const result = await recordKycAtDesk('pub_1', { govIdType: 'AADHAAR', govIdFrontUrl: 'https://x/front.png', panNumber: 'ABCDE1234F', manifestVersion: 3 }, 'usr_admin');
    expect(repository.submitKyc).toHaveBeenCalledWith(
      'pub_1',
      { govIdType: 'AADHAAR', govIdFrontUrl: 'https://x/front.png', panNumber: 'ABCDE1234F' },
      { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL' },
    );
    expect(repository.pinKycManifestVersion).toHaveBeenCalledWith('pub_1', 3);
    expect(kyc.clearDocumentReviews).toHaveBeenCalledWith('PUBLISHER', 'kyc_1', ['govIdType', 'govIdFrontUrl', 'panNumber']);
    expect(result).toMatchObject({ status: 'PENDING', recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', submittedAt: NOW });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'PUBLISHER_KYC_RECORDED_AT_DESK',
      expect.objectContaining({ targetType: 'Publisher', targetId: 'pub_1', module: 'publishers', metadata: expect.objectContaining({ kycId: 'kyc_1', fields: ['govIdType', 'govIdFrontUrl', 'panNumber'] }) }),
    );
    expect(audit.auditDiff).toHaveBeenCalled();
  });

  it('is refused 409 KYC_ALREADY_VERIFIED on a VERIFIED record and 400 EMPTY_RESUBMISSION while NEEDS_INFO with no document', async () => {
    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: { ...publisher.kyc, status: 'VERIFIED' } });
    await expect(recordKycAtDesk('pub_1', { selfieUrl: 'https://x/s.png' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: { ...publisher.kyc, status: 'NEEDS_INFO' } });
    await expect(recordKycAtDesk('pub_1', { panNumber: 'ABCDE1234F' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    expect(repository.submitKyc).not.toHaveBeenCalled();
  });

  it('is 404 for a publisher that is not there', async () => {
    repository.findKycDetail.mockResolvedValue(null);
    await expect(recordKycAtDesk('pub_9', { selfieUrl: 'https://x/s.png' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('GET /publishers/kyc-queue — the requested facet', () => {
  it('passes ?requested=true through, counts the requested across the queue, and names who requested and who recorded on every row', async () => {
    repository.findKycQueue.mockResolvedValue([
      { ...publisher, kyc: { ...publisher.kyc, requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'MANUAL', recordedById: 'usr_desk', recordedVia: 'DESK' } },
    ]);
    repository.countKycQueue.mockResolvedValue(3);
    const page = await listKycQueue({ status: 'PENDING', requested: true }, NOW);
    expect(repository.findKycQueue).toHaveBeenCalledWith({ status: 'PENDING', requested: true });
    // N3-B: the requested chip is the REQUESTED state, counted with the state facet (and its aliases) removed.
    expect(repository.countKycQueue).toHaveBeenCalledWith({ status: undefined, state: undefined, requested: true });
    expect(page.counts).toMatchObject({ escalated: 0, requested: 3 });
    expect(page.requested).toBe(3);
    expect(page.items[0]).toMatchObject({
      requestedBy: { id: 'usr_admin', name: 'name of usr_admin' },
      recordedBy: { id: 'usr_desk', name: 'name of usr_desk' },
    });
    expect(page.items[0]!.kyc).toMatchObject({ requestedAt: NOW, requestedChannel: 'MANUAL', recordedVia: 'DESK' });
  });

  it('counts the requested with the facet removed when the queue is not on it', async () => {
    repository.countKycQueue.mockResolvedValue(2);
    const page = await listKycQueue({ status: 'PENDING' }, NOW);
    expect(repository.countKycQueue).toHaveBeenCalledWith({ status: undefined, state: undefined, requested: true });
    expect(page.counts.requested).toBe(2);
  });
});
