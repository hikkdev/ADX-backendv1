import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q42/Q119/Q131) — the publisher KYC desk.
 *
 * What is pinned: a per-document decision is recorded against the KYC row
 * and audited; a re-upload request flags the fields, moves the row and the
 * publisher's mirror to NEEDS_INFO, keeps the files, tells the publisher
 * what to send again, and is audited with the status diff; the decision
 * remembers who and what, tells the publisher either way, and refuses to
 * verify a manual-path record with no liveness video (the Digio path is
 * exempt); assignment is a filter — `me`, another admin, or nobody — and
 * never gates a decision; the queue's new facets parse.
 */

const { repository, kyc, notifications, audit, agents } = vi.hoisted(() => ({
  repository: {
    findKycDetail: vi.fn(),
    findSummaryById: vi.fn(),
    reviewKyc: vi.fn(),
    requestKycReupload: vi.fn(),
    assignKyc: vi.fn(),
  },
  kyc: {
    recordDocumentReview: vi.fn(),
    flagDocuments: vi.fn(),
    flaggedDocuments: vi.fn(),
    listDocumentReviews: vi.fn(),
    clearDocumentReviews: vi.fn(),
    hasSubmittedLiveness: vi.fn(),
    livenessStateFor: vi.fn(),
    purgeCutoff: vi.fn(),
    maskPan: vi.fn(),
    trimDigioPayload: vi.fn(),
  },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  agents: { getAgentWithUser: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../kyc', () => kyc);
vi.mock('../../notifications', () => notifications);
vi.mock('../../agents', () => ({ getAgentWithUser: agents.getAgentWithUser, findAgentProfile: vi.fn(), requireAgentProfile: vi.fn(), findAgentTier: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../uploads', () => ({ purgeStoredFile: vi.fn(), fileIdFromUrl: vi.fn(() => null) }));

import { agentKycDecisionNotice, assignKycCase, assignKycCases, requestKycReupload, reviewKyc, reviewKycDocument } from '../kyc/kyc-desk.service';
import { kycQueueQuerySchema, PUBLISHER_KYC_DOCUMENT_FIELDS } from '../publishers.schema';

const publisher = {
  id: 'pub_1',
  userId: 'usr_pub',
  name: 'Asha Rao',
  kycStatus: 'PENDING',
  kyc: { id: 'kyc_1', publisherId: 'pub_1', status: 'PENDING', method: 'MANUAL', govIdFrontUrl: '/api/v1/files/f1', assignedToId: null },
  agent: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findKycDetail.mockResolvedValue(publisher);
  repository.reviewKyc.mockImplementation(async (_id: string, status: string, rejectionReason?: string) => ({ ...publisher.kyc, status, rejectionReason: rejectionReason ?? null }));
  repository.requestKycReupload.mockResolvedValue({ ...publisher.kyc, status: 'NEEDS_INFO', reviewNote: 'Blurry' });
  repository.assignKyc.mockResolvedValue(1);
  kyc.hasSubmittedLiveness.mockResolvedValue(true);
  kyc.flaggedDocuments.mockResolvedValue([{ field: 'govIdFrontUrl', note: 'Blurry' }]);
  kyc.recordDocumentReview.mockImplementation(async (_p: string, kycId: string, input: { field: string; decision: string; note: string | null }) => ({ id: 'rev_1', kycId, ...input }));
});

describe('the queue query', () => {
  it('takes NEEDS_INFO, the assignment facet and the Digio facets', () => {
    expect(kycQueueQuerySchema.parse({ status: 'needs_info', assignedTo: 'me' })).toEqual({ status: 'NEEDS_INFO', assignedTo: 'me' });
    expect(kycQueueQuerySchema.parse({ method: 'DIGIO', digioStatus: 'stuck' })).toEqual({ method: 'DIGIO', digioStatus: 'stuck' });
    expect(kycQueueQuerySchema.safeParse({ assignedTo: 'someone' }).success).toBe(false);
    expect(kycQueueQuerySchema.safeParse({ digioStatus: 'done' }).success).toBe(false);
  });
});

describe('one document', () => {
  it('records the decision against the KYC row and audits it', async () => {
    const review = await reviewKycDocument('pub_1', 'govIdFrontUrl', { decision: 'FLAGGED', note: 'Blurry' }, 'usr_admin');
    expect(kyc.recordDocumentReview).toHaveBeenCalledWith('PUBLISHER', 'kyc_1', { field: 'govIdFrontUrl', decision: 'FLAGGED', note: 'Blurry' }, 'usr_admin');
    expect(review).toMatchObject({ field: 'govIdFrontUrl', decision: 'FLAGGED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_DOCUMENT_REVIEWED', expect.objectContaining({ targetType: 'Publisher', targetId: 'pub_1' }));
  });

  it('refuses a field the record does not have', async () => {
    await expect(reviewKycDocument('pub_1', 'passportScanUrl', { decision: 'APPROVED' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    expect(PUBLISHER_KYC_DOCUMENT_FIELDS).toContain('selfieUrl');
    expect(PUBLISHER_KYC_DOCUMENT_FIELDS).not.toContain('panNumber');
  });

  it('is 404 for a publisher with no KYC row', async () => {
    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: null });
    await expect(reviewKycDocument('pub_1', 'selfieUrl', { decision: 'APPROVED' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('asking for a re-upload', () => {
  it('flags the fields, moves both rows to NEEDS_INFO, keeps the files, tells the publisher, audits the diff', async () => {
    const result = await requestKycReupload('pub_1', { fields: ['govIdFrontUrl', 'selfieUrl'], note: 'Blurry' }, 'usr_admin');
    expect(kyc.flagDocuments).toHaveBeenCalledWith('PUBLISHER', 'kyc_1', ['govIdFrontUrl', 'selfieUrl'], 'Blurry', 'usr_admin');
    expect(repository.requestKycReupload).toHaveBeenCalledWith('pub_1', { reviewedById: 'usr_admin', reviewNote: 'Blurry' });
    expect(result).toMatchObject({ status: 'NEEDS_INFO', flagged: [{ field: 'govIdFrontUrl', note: 'Blurry' }] });
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_pub', type: 'KYC', suggestedAction: expect.stringMatching(/^Re-upload/), relatedId: 'pub_1' }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_REUPLOAD_REQUESTED', expect.objectContaining({ targetId: 'pub_1', metadata: expect.objectContaining({ fields: ['govIdFrontUrl', 'selfieUrl'] }) }));
    expect(audit.auditDiff).toHaveBeenCalled();
  });

  it('is 409 once verified and 400 for a field the record does not have', async () => {
    await expect(requestKycReupload('pub_1', { fields: ['nope'], note: 'x' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: { ...publisher.kyc, status: 'VERIFIED' } });
    await expect(requestKycReupload('pub_1', { fields: ['selfieUrl'], note: 'x' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not nudge a publisher who has no app account, and still records the ask', async () => {
    repository.findKycDetail.mockResolvedValue({ ...publisher, userId: null });
    await requestKycReupload('pub_1', { fields: ['selfieUrl'], note: 'x' }, 'usr_admin');
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(repository.requestKycReupload).toHaveBeenCalled();
  });
});

describe('the decision', () => {
  it('stamps who and what, tells the publisher through the dispatcher, audits with a diff', async () => {
    const result = await reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin', note: 'All clear' });
    expect(repository.reviewKyc).toHaveBeenCalledWith('pub_1', 'VERIFIED', undefined, { reviewedById: 'usr_admin', reviewNote: 'All clear' });
    expect(result).toMatchObject({ status: 'VERIFIED' });
    // Lot E1/F: one notify call — the in-app row plus the seeded kyc-decision
    // template's email and SMS, each subject to the publisher's KYC preference.
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_DECISION',
      'usr_pub',
      { partyName: 'Asha Rao', decision: 'verified', reason: expect.any(String) },
      { inApp: expect.objectContaining({ type: 'KYC', title: expect.stringMatching(/verified/i), relatedId: 'pub_1' }) },
    );
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_REVIEWED', expect.objectContaining({ targetType: 'Publisher', targetId: 'pub_1' }));

    await reviewKyc('pub_1', 'REJECTED', 'Name mismatch', { userId: 'usr_admin' });
    expect(notifications.notify).toHaveBeenLastCalledWith(
      'KYC_DECISION',
      'usr_pub',
      { partyName: 'Asha Rao', decision: 'not verified', reason: 'Name mismatch' },
      { inApp: expect.objectContaining({ message: expect.stringContaining('Name mismatch') }) },
    );
  });

  /* Lot F (E7-1): the agent who brought the publisher in sees the decision
     as a modal — publisherId, publisherName, status, decidedAt on the row. */
  it('tells the onboarding agent, in-app, with the facts the modal prints; no agent, no notice', async () => {
    const decidedAt = new Date('2026-09-12T09:00:00Z');
    repository.findKycDetail.mockResolvedValue({ ...publisher, agentId: 'agt_1', agent: { id: 'agt_1' } });
    repository.reviewKyc.mockResolvedValue({ ...publisher.kyc, status: 'VERIFIED', reviewedAt: decidedAt });
    agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent' });

    await reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' });
    expect(agents.getAgentWithUser).toHaveBeenCalledWith('agt_1');
    expect(notifications.createNotification).toHaveBeenCalledWith({
      userId: 'usr_agent',
      type: 'KYC',
      title: 'KYC verified',
      subtitle: 'Asha Rao',
      message: expect.stringContaining('KYC_DECISION_AGENT'),
      suggestedAction: 'Open the publisher',
      relatedId: 'pub_1',
      // E9: the columns the row now has — what the modal prints, as data.
      relatedType: 'PUBLISHER',
      payload: { publisherId: 'pub_1', publisherName: 'Asha Rao', status: 'VERIFIED', decidedAt: decidedAt.toISOString() },
    });
    expect(agentKycDecisionNotice({ id: 'pub_1', name: 'Asha Rao' }, { status: 'REJECTED', reviewedAt: decidedAt })).toMatchObject({
      relatedType: 'PUBLISHER',
      relatedId: 'pub_1',
      title: 'KYC rejected',
      message: expect.stringContaining('2026-09-12'),
      payload: { publisherId: 'pub_1', publisherName: 'Asha Rao', status: 'REJECTED', decidedAt: decidedAt.toISOString() },
    });

    notifications.createNotification.mockClear();
    repository.findKycDetail.mockResolvedValue({ ...publisher, agentId: null });
    await reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' });
    expect(notifications.createNotification).not.toHaveBeenCalled();

    // The agent lookup failing never fails the review.
    repository.findKycDetail.mockResolvedValue({ ...publisher, agentId: 'agt_1' });
    agents.getAgentWithUser.mockRejectedValue(new Error('down'));
    await expect(reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it('refuses to verify a manual-path publisher with no liveness video, 409 LIVENESS_REQUIRED', async () => {
    kyc.hasSubmittedLiveness.mockResolvedValue(false);
    await expect(reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409, code: 'LIVENESS_REQUIRED' });
    expect(repository.reviewKyc).not.toHaveBeenCalled();
    // A rejection needs no video.
    await expect(reviewKyc('pub_1', 'REJECTED', 'No', { userId: 'usr_admin' })).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('lets the Digio path through without a video: Digio did the liveness check', async () => {
    kyc.hasSubmittedLiveness.mockResolvedValue(false);
    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: { ...publisher.kyc, method: 'DIGIO' } });
    await expect(reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).resolves.toMatchObject({ status: 'VERIFIED' });
    expect(kyc.hasSubmittedLiveness).not.toHaveBeenCalled();
  });

  it('checks the video against the publisher who owns the row, and a row with no owner cannot have one', async () => {
    await reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' });
    expect(kyc.hasSubmittedLiveness).toHaveBeenCalledWith('usr_pub');
    repository.findKycDetail.mockResolvedValue({ ...publisher, userId: null });
    await expect(reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).rejects.toMatchObject({ code: 'LIVENESS_REQUIRED' });
  });
});

describe('assignment', () => {
  it('is a filter: me, another admin, or nobody — audited, never gating a decision', async () => {
    await assignKycCase('pub_1', { adminUserId: 'me' }, 'usr_admin');
    expect(repository.assignKyc).toHaveBeenCalledWith(['pub_1'], 'usr_admin', expect.any(Date));
    await assignKycCase('pub_1', { adminUserId: null }, 'usr_admin');
    expect(repository.assignKyc).toHaveBeenLastCalledWith(['pub_1'], null, expect.any(Date));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_ASSIGNED', expect.objectContaining({ targetId: 'pub_1' }));

    repository.findKycDetail.mockResolvedValue({ ...publisher, kyc: { ...publisher.kyc, assignedToId: 'usr_other' } });
    await expect(reviewKyc('pub_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it('assigns in bulk and reports how many moved', async () => {
    repository.assignKyc.mockResolvedValue(3);
    const result = await assignKycCases({ ids: ['pub_1', 'pub_2', 'pub_3'], adminUserId: 'usr_x' }, 'usr_admin');
    expect(result).toEqual({ assigned: 3, adminUserId: 'usr_x' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_KYC_ASSIGNED_BULK', expect.objectContaining({ metadata: expect.objectContaining({ ids: ['pub_1', 'pub_2', 'pub_3'] }) }));
  });
});
