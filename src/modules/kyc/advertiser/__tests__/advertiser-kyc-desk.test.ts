import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q42/Q119/Q131) — the advertiser KYC desk, the publisher desk's twin.
 *
 * What is pinned: a per-document decision is recorded and audited; a
 * re-upload request flags, moves the row to NEEDS_INFO, tells the advertiser,
 * and is refused once verified; the decision stamps who and what, flips the
 * booking gate, tells the advertiser either way, and refuses to verify a
 * manual-path record with no liveness video (the Digio path is exempt); a
 * resubmission while NEEDS_INFO clears the decisions on the fields sent; the
 * case read carries the decisions and the video; assignment is a filter.
 */

const { repository, advertisers, notifications, audit, reviews, liveness, escalation } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findByAdvertiserId: vi.fn(),
    findByProfileId: vi.fn(),
    review: vi.fn(),
    requestReupload: vi.fn(),
    assign: vi.fn(),
    resubmit: vi.fn(),
    pinManifestVersion: vi.fn(),
  },
  advertisers: { applyKycDecision: vi.fn(), applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn(), findAdvertiser: vi.fn() },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  reviews: {
    recordDocumentReview: vi.fn(),
    flagDocuments: vi.fn(),
    flaggedDocuments: vi.fn(),
    listDocumentReviews: vi.fn(),
    // E10-1: the case read names the reviewer on each tile.
    listDocumentReviewsWithReviewer: vi.fn(),
    clearDocumentReviews: vi.fn(),
  },
  liveness: { hasSubmittedLiveness: vi.fn(), livenessStateFor: vi.fn() },
  // Lot G (Q127/142): the escalation body lives in kyc/escalation.service; the desk is the door.
  escalation: { escalateKyc: vi.fn(async () => ({ party: 'ADVERTISER', kycId: 'akyc_1', escalatedToUserId: 'usr_comp' })) },
}));

vi.mock('../prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../../../advertisers', () => advertisers);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../document-review/document-review.service', () => reviews);
vi.mock('../../user/user-kyc.service', () => liveness);
vi.mock('../../escalation.service', () => escalation);
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })), getFlow: vi.fn(async () => ({ version: 7 })), ONBOARDING_FLOW_KEY: 'onboarding' }));

import {
  advertiserKycReviewStateFor,
  assignAdvertiserCase,
  escalateAdvertiserCase,
  getAdvertiserKycCase,
  requestAdvertiserReupload,
  resubmitAdvertiserKyc,
  reviewAdvertiserDocument,
  reviewAdvertiserKyc,
} from '../advertiser-kyc.service';

// N3-B: the self paths resolve through the caller's profile (adv_1); the write key carries both ids —
// and, for this legacy row (no profile key on it yet), the row's own id, so the write adopts the profile key.
const KEY = { id: 'akyc_1', advertiserProfileId: 'adv_1', advertiserId: 'usr_adv' };
const row = { id: 'akyc_1', advertiserId: 'usr_adv', status: 'PENDING', method: 'MANUAL', govIdFrontUrl: '/api/v1/files/f1', assignedToId: null, reviewNote: null };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(row);
  repository.findByAdvertiserId.mockResolvedValue(row);
  // N3-B: the record is looked up by the profile first; here it answers whatever the user key answers.
  repository.findByProfileId.mockImplementation(() => repository.findByAdvertiserId('usr_adv'));
  repository.review.mockImplementation(async (_id: string, status: string, rejectionReason: string | null, stamp?: object) => ({ ...row, status, rejectionReason, ...(stamp ?? {}) }));
  repository.requestReupload.mockResolvedValue({ ...row, status: 'NEEDS_INFO', reviewNote: 'Blurry' });
  repository.resubmit.mockImplementation(async (_advertiserId: string, data: Record<string, unknown>) => ({ ...row, ...data, status: 'PENDING', rejectionReason: null }));
  repository.pinManifestVersion.mockResolvedValue({ count: 1 });
  repository.assign.mockResolvedValue(1);
  advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1', name: 'Meera S', companyName: null });
  liveness.hasSubmittedLiveness.mockResolvedValue(true);
  liveness.livenessStateFor.mockResolvedValue({ id: 'ukyc_1', status: 'PENDING', fileId: 'f9' });
  reviews.flaggedDocuments.mockResolvedValue([{ field: 'govIdFrontUrl', note: 'Blurry' }]);
  reviews.listDocumentReviews.mockResolvedValue([{ field: 'govIdFrontUrl', decision: 'FLAGGED' }]);
  reviews.listDocumentReviewsWithReviewer.mockResolvedValue([{ field: 'govIdFrontUrl', decision: 'FLAGGED', reviewedById: 'usr_admin', reviewedBy: { id: 'usr_admin', name: null } }]);
  reviews.recordDocumentReview.mockImplementation(async (_p: string, kycId: string, input: object) => ({ id: 'rev_1', kycId, ...input }));
});

describe('one document', () => {
  it('records the decision against the row and audits it; an unknown field is 400', async () => {
    await expect(reviewAdvertiserDocument('akyc_1', 'govIdFrontUrl', { decision: 'FLAGGED', note: 'Blurry' }, 'usr_admin')).resolves.toMatchObject({ field: 'govIdFrontUrl' });
    expect(reviews.recordDocumentReview).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', { field: 'govIdFrontUrl', decision: 'FLAGGED', note: 'Blurry' }, 'usr_admin');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_DOCUMENT_REVIEWED', expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_1' }));
    await expect(reviewAdvertiserDocument('akyc_1', 'panNumber', { decision: 'APPROVED' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('asking for a re-upload', () => {
  it('flags, moves to NEEDS_INFO, tells the advertiser, audits; refused once verified', async () => {
    const result = await requestAdvertiserReupload('akyc_1', { fields: ['govIdFrontUrl'], note: 'Blurry' }, 'usr_admin');
    expect(reviews.flagDocuments).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', ['govIdFrontUrl'], 'Blurry', 'usr_admin');
    expect(repository.requestReupload).toHaveBeenCalledWith('akyc_1', { reviewedById: 'usr_admin', reviewNote: 'Blurry' });
    expect(result).toMatchObject({ status: 'NEEDS_INFO', flagged: [{ field: 'govIdFrontUrl', note: 'Blurry' }] });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', type: 'KYC', suggestedAction: expect.stringMatching(/^Re-upload/) }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_REUPLOAD_REQUESTED', expect.anything());

    repository.findById.mockResolvedValue({ ...row, status: 'VERIFIED' });
    await expect(requestAdvertiserReupload('akyc_1', { fields: ['selfieUrl'], note: 'x' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a resubmission while NEEDS_INFO clears the decisions on the fields sent and returns to PENDING', async () => {
    await resubmitAdvertiserKyc('usr_adv', { govIdFrontUrl: 'https://x/new.png' });
    expect(repository.resubmit).toHaveBeenCalledWith(KEY, { govIdFrontUrl: 'https://x/new.png' });
    expect(reviews.clearDocumentReviews).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', ['govIdFrontUrl']);
  });

  /* Lot F (E7-1): the flagged-only resubmission, end to end at the service
     level — the desk flags two tiles, the phone sends exactly those two DR 08
     columns, the case is PENDING again, only those two decisions are gone,
     the rest of the row and its decisions stand. */
  it('takes a PARTIAL body of the DR 08 columns while NEEDS_INFO: the flagged fields land, the rest stay, the case is PENDING, the flags on the fields sent are cleared', async () => {
    const needsInfo = {
      ...row,
      status: 'NEEDS_INFO',
      govIdFrontUrl: 'https://adx.local/api/v1/files/old-front',
      govIdBackUrl: 'https://adx.local/api/v1/files/old-back',
      selfieUrl: 'https://adx.local/api/v1/files/old-selfie',
      panNumber: 'ABCDE1234F',
      manifestVersion: 3,
    };
    repository.findById.mockResolvedValue(needsInfo);
    repository.findByAdvertiserId.mockResolvedValue(needsInfo);
    // The repository writes the columns sent onto the row it holds and keeps the rest.
    repository.resubmit.mockImplementation(async (_advertiserId: string, data: Record<string, unknown>) => ({ ...needsInfo, ...data, status: 'PENDING', rejectionReason: null }));
    reviews.flagDocuments.mockResolvedValue([]);
    reviews.flaggedDocuments.mockResolvedValue([
      { field: 'govIdFrontUrl', note: 'Blurry' },
      { field: 'selfieUrl', note: 'Blurry' },
    ]);
    repository.requestReupload.mockResolvedValue({ ...needsInfo, reviewNote: 'Blurry' });

    // The desk asks for two tiles again.
    const asked = await requestAdvertiserReupload('akyc_1', { fields: ['govIdFrontUrl', 'selfieUrl'], note: 'Blurry' }, 'usr_admin');
    expect(asked.flagged.map((f) => f.field)).toEqual(['govIdFrontUrl', 'selfieUrl']);

    // The phone sends only those two — nothing else was collected.
    const partial = { govIdFrontUrl: 'https://adx.local/api/v1/files/new-front', selfieUrl: 'https://adx.local/api/v1/files/new-selfie' };
    const resubmitted = await resubmitAdvertiserKyc('usr_adv', partial);

    // Only the columns sent are written; the repository keeps the rest.
    expect(repository.resubmit).toHaveBeenCalledWith(KEY, partial);
    expect(resubmitted).toMatchObject({
      status: 'PENDING',
      rejectionReason: null,
      govIdFrontUrl: 'https://adx.local/api/v1/files/new-front',
      selfieUrl: 'https://adx.local/api/v1/files/new-selfie',
      govIdBackUrl: 'https://adx.local/api/v1/files/old-back',
      panNumber: 'ABCDE1234F',
    });
    // Exactly the fields sent start clean; a decision on govIdBackUrl would stand.
    expect(reviews.clearDocumentReviews).toHaveBeenCalledTimes(1);
    expect(reviews.clearDocumentReviews).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', ['govIdFrontUrl', 'selfieUrl']);
    // Nobody is told on a resubmission; the desk sees it in the queue.
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('the manifest pin: written once at a submission — the version the phone sent, else the live one — and never part of the columns', async () => {
    await resubmitAdvertiserKyc('usr_adv', { govIdFrontUrl: 'https://x/new.png', manifestVersion: 3 });
    expect(repository.resubmit).toHaveBeenLastCalledWith(KEY, { govIdFrontUrl: 'https://x/new.png' });
    expect(repository.pinManifestVersion).toHaveBeenLastCalledWith(KEY, 3);
    expect(reviews.clearDocumentReviews).toHaveBeenLastCalledWith('ADVERTISER', 'akyc_1', ['govIdFrontUrl']);

    await resubmitAdvertiserKyc('usr_adv', { selfieUrl: 'https://x/selfie.png' });
    expect(repository.pinManifestVersion).toHaveBeenLastCalledWith(KEY, 7);
  });

  it('PUT /me on a fresh advertiser is the first submission: the repository upserts, nothing is 404', async () => {
    repository.findByAdvertiserId.mockResolvedValue(null);
    await expect(resubmitAdvertiserKyc('usr_new', { govIdFrontUrl: 'https://x/front.png' })).resolves.toMatchObject({ status: 'PENDING' });
    expect(repository.resubmit).toHaveBeenCalledWith({ advertiserProfileId: 'adv_1', advertiserId: 'usr_new' }, { govIdFrontUrl: 'https://x/front.png' });
  });
});

/* E9 (the E7 verifier): while NEEDS_INFO, a body that names no document field
   attaches nothing — it must not bounce the case back to PENDING with the
   same files under a fresh submittedAt. */
describe('an empty resubmission while NEEDS_INFO', () => {
  it('is refused 400 EMPTY_RESUBMISSION, and neither the row nor the flags move', async () => {
    repository.findByAdvertiserId.mockResolvedValue({ ...row, status: 'NEEDS_INFO' });
    await expect(resubmitAdvertiserKyc('usr_adv', { kycType: 'INDIVIDUAL', manifestVersion: 3 })).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    await expect(resubmitAdvertiserKyc('usr_adv', {})).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    expect(repository.resubmit).not.toHaveBeenCalled();
    expect(repository.pinManifestVersion).not.toHaveBeenCalled();
    expect(reviews.clearDocumentReviews).not.toHaveBeenCalled();

    // One document is enough; the fields sent are the ones whose decisions clear.
    await resubmitAdvertiserKyc('usr_adv', { selfieUrl: 'https://x/selfie.png' });
    expect(repository.resubmit).toHaveBeenCalledWith(KEY, { selfieUrl: 'https://x/selfie.png' });
    expect(reviews.clearDocumentReviews).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', ['selfieUrl']);
  });

  it('binds only NEEDS_INFO: a first submission or a PENDING case still takes a body with no document', async () => {
    repository.findByAdvertiserId.mockResolvedValue(null);
    await expect(resubmitAdvertiserKyc('usr_new', { kycType: 'COMMERCIAL' })).resolves.toMatchObject({ status: 'PENDING' });
    repository.findByAdvertiserId.mockResolvedValue(row);
    await expect(resubmitAdvertiserKyc('usr_adv', { kycType: 'COMMERCIAL' })).resolves.toMatchObject({ status: 'PENDING' });
  });
});

describe('the decision', () => {
  it('stamps who and what, flips the gate, tells the advertiser, audits', async () => {
    const result = await reviewAdvertiserKyc('akyc_1', 'VERIFIED', undefined, { userId: 'usr_admin', note: 'All clear' });
    expect(repository.review).toHaveBeenCalledWith('akyc_1', 'VERIFIED', null, { reviewedById: 'usr_admin', reviewNote: 'All clear' });
    expect(advertisers.applyKycDecisionByUserId).toHaveBeenCalledWith('usr_adv', 'VERIFIED');
    expect(result).toMatchObject({ status: 'VERIFIED', reviewedById: 'usr_admin' });
    // Lot E1/F: one notify call — the in-app row and the seeded kyc-decision template's channels.
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_DECISION',
      'usr_adv',
      { partyName: 'Meera S', decision: 'verified', reason: expect.any(String) },
      { inApp: expect.objectContaining({ type: 'KYC', title: 'Identity verified', relatedId: 'akyc_1' }) },
    );
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_REVIEWED', expect.objectContaining({ targetId: 'akyc_1' }));
  });

  it('a rejection carries the reason into the template variables', async () => {
    await reviewAdvertiserKyc('akyc_1', 'REJECTED', 'Name mismatch', { userId: 'usr_admin' });
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_DECISION',
      'usr_adv',
      { partyName: 'Meera S', decision: 'not verified', reason: 'Name mismatch' },
      { inApp: expect.objectContaining({ title: 'Identity check did not clear', message: expect.stringContaining('Name mismatch') }) },
    );
  });

  it('refuses to verify a manual-path record with no video, and lets the Digio path through', async () => {
    liveness.hasSubmittedLiveness.mockResolvedValue(false);
    await expect(reviewAdvertiserKyc('akyc_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409, code: 'LIVENESS_REQUIRED' });
    await expect(reviewAdvertiserKyc('akyc_1', 'REJECTED', 'No', { userId: 'usr_admin' })).resolves.toMatchObject({ status: 'REJECTED' });
    repository.findById.mockResolvedValue({ ...row, method: 'DIGIO' });
    await expect(reviewAdvertiserKyc('akyc_1', 'VERIFIED', undefined, { userId: 'usr_admin' })).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it('still works without a reviewer, as the webhook-era callers used it: no stamp, no notification', async () => {
    await reviewAdvertiserKyc('akyc_1', 'VERIFIED');
    expect(repository.review).toHaveBeenCalledWith('akyc_1', 'VERIFIED', null, undefined);
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('the case and the filter', () => {
  it('reads the row with its decisions and the video, and reports the state the manifest needs', async () => {
    await expect(getAdvertiserKycCase('akyc_1')).resolves.toMatchObject({
      id: 'akyc_1',
      documentReviews: [{ field: 'govIdFrontUrl' }],
      liveness: { fileId: 'f9' },
      // E7-3: the age against the SLA and the people, by name, beside the ids.
      slaHours: 48,
      slaBreached: false,
      reviewedBy: null,
      assignedTo: null,
      recordedBy: null,
    });
    await expect(advertiserKycReviewStateFor('usr_adv')).resolves.toEqual({ status: 'PENDING', method: 'MANUAL', reviewNote: null, manifestVersion: null, flagged: [{ field: 'govIdFrontUrl', note: 'Blurry' }] });
    repository.findByAdvertiserId.mockResolvedValue(null);
    await expect(advertiserKycReviewStateFor('usr_new')).resolves.toBeNull();
  });

  it('assigns me, another admin, or nobody, audited', async () => {
    await assignAdvertiserCase('akyc_1', { adminUserId: 'me' }, 'usr_admin');
    expect(repository.assign).toHaveBeenCalledWith(['akyc_1'], 'usr_admin', expect.any(Date));
    await assignAdvertiserCase('akyc_1', { adminUserId: null }, 'usr_admin');
    expect(repository.assign).toHaveBeenLastCalledWith(['akyc_1'], null, expect.any(Date));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_ASSIGNED', expect.anything());
  });
});

describe('Lot G (Q127/142): escalating from the desk', () => {
  it('hands the case to kyc/escalation as REVIEWER with the reason, and answers the case', async () => {
    const result = await escalateAdvertiserCase('akyc_1', { reason: 'PAN does not match the GST' }, 'usr_ops');
    expect(escalation.escalateKyc).toHaveBeenCalledWith({ party: 'ADVERTISER', kycId: 'akyc_1' }, { reason: 'PAN does not match the GST', byUserId: 'usr_ops', req: undefined }, expect.any(Date));
    expect(result).toMatchObject({ id: 'akyc_1', documentReviews: expect.any(Array) });
  });

  it('404s a row that does not exist before touching the escalation', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(escalateAdvertiserCase('akyc_x', { reason: 'x' }, 'usr_ops')).rejects.toMatchObject({ statusCode: 404 });
    expect(escalation.escalateKyc).not.toHaveBeenCalled();
  });
});
