import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — the PAN photo under both names. The manifest (and the phone
 * and the website) call it `panFrontUrl`; the advertiser row keeps
 * `panCardUrl`. `PUT /advertiser-kyc/me` used to strip `panFrontUrl` and
 * lose the photo; the desk's flag on `panCardUrl` never reached the
 * manifest's PAN tile. Both names now go in, both come out, and the flag
 * reaches the tile.
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
  getMyAdvertiserKyc,
  requestAdvertiserReupload,
  resubmitAdvertiserKyc,
  reviewAdvertiserDocument,
} from '../advertiser-kyc.service';
import { createAdvertiserKycSchema, updateAdvertiserKycSchema } from '../advertiser-kyc.schema';

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

describe('the PAN photo alias', () => {
  it('folds panFrontUrl into panCardUrl on the way in; an explicit panCardUrl wins', () => {
    expect(updateAdvertiserKycSchema.parse({ panFrontUrl: 'https://f/pan' })).toEqual({ panCardUrl: 'https://f/pan' });
    expect(updateAdvertiserKycSchema.parse({ panFrontUrl: 'https://f/a', panCardUrl: 'https://f/b' })).toEqual({ panCardUrl: 'https://f/b' });
    expect(createAdvertiserKycSchema.parse({ panFrontUrl: 'https://f/pan' })).toMatchObject({ kycType: 'INDIVIDUAL', panCardUrl: 'https://f/pan' });
    expect(updateAdvertiserKycSchema.safeParse({ panFrontUrl: 'not a url' }).success).toBe(false);
  });

  it('writes the photo sent as panFrontUrl and answers it under both names', async () => {
    const out = await resubmitAdvertiserKyc('usr_adv', updateAdvertiserKycSchema.parse({ panFrontUrl: 'https://f/pan' }));
    expect(repository.resubmit).toHaveBeenCalledWith(KEY, { panCardUrl: 'https://f/pan' });
    expect(reviews.clearDocumentReviews).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', ['panCardUrl']);
    expect(out).toMatchObject({ panCardUrl: 'https://f/pan', panFrontUrl: 'https://f/pan' });
  });

  it('a NEEDS_INFO resubmission carrying only panFrontUrl counts as a document', async () => {
    repository.findByAdvertiserId.mockResolvedValue({ ...row, status: 'NEEDS_INFO' });
    await expect(resubmitAdvertiserKyc('usr_adv', updateAdvertiserKycSchema.parse({ panFrontUrl: 'https://f/pan' }))).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('GET /me answers panFrontUrl beside panCardUrl', async () => {
    repository.findByAdvertiserId.mockResolvedValue({ ...row, panCardUrl: 'https://f/pan' });
    await expect(getMyAdvertiserKyc('usr_adv')).resolves.toMatchObject({ panCardUrl: 'https://f/pan', panFrontUrl: 'https://f/pan' });
  });

  it('a flagged panCardUrl reaches the manifest as panFrontUrl too', async () => {
    reviews.flaggedDocuments.mockResolvedValue([{ field: 'panCardUrl', note: 'Glare' }]);
    const state = await advertiserKycReviewStateFor('usr_adv');
    expect(state?.flagged).toEqual([{ field: 'panCardUrl', note: 'Glare' }, { field: 'panFrontUrl', note: 'Glare' }]);
  });

  it('the desk may name the tile panFrontUrl; it is recorded as panCardUrl', async () => {
    await reviewAdvertiserDocument('akyc_1', 'panFrontUrl', { decision: 'FLAGGED', note: 'Glare' }, 'usr_admin');
    expect(reviews.recordDocumentReview).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', { field: 'panCardUrl', decision: 'FLAGGED', note: 'Glare' }, 'usr_admin');
    await requestAdvertiserReupload('akyc_1', { fields: ['panFrontUrl', 'panCardUrl'], note: 'Glare' }, 'usr_admin');
    expect(reviews.flagDocuments).toHaveBeenCalledWith('ADVERTISER', 'akyc_1', ['panCardUrl'], 'Glare', 'usr_admin');
  });
});
