import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N2-B — the advertiser KYC contract gaps the Lot N verifier found.
 *
 * What is pinned: `GET /advertiser-kyc/:id` and `PUT /advertiser-kyc/:id`
 * resolve `:id` as the KYC row id FIRST, then as the advertiser's user id —
 * the way `POST /:id/request` already does; a desk PUT over a user id with
 * no row CREATES the row (advertiserId, kycType from the body or the
 * advertiser's entity type, recordedVia DESK, PENDING, submittedAt), so the
 * console can record at the desk before any request; every desk PUT and the
 * advertiser's own `PUT /me` refuse a VERIFIED record with 409
 * `KYC_ALREADY_VERIFIED` (NEEDS_INFO still lets a resubmission through);
 * `GET /advertiser-kyc?advertiserId=` narrows the queue to one row or none.
 *
 * N3-B: the record is keyed by the Advertiser PROFILE (`advertiserProfileId`);
 * the user id is the legacy key and may be null. `:id` resolves as the row
 * id, then the profile id, then the user id; a desk creation over a profile
 * with no user carries `advertiserProfileId` only; every status write
 * mirrors `Advertiser.kycStatus`.
 */

const { repository, advertisers, notifications, audit, digio, settings, labels, reviews } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findByAdvertiserId: vi.fn(),
    findByProfileId: vi.fn(),
    updateById: vi.fn(),
    createAtDesk: vi.fn(),
    resubmit: vi.fn(),
    pinManifestVersion: vi.fn(),
    findPage: vi.fn(),
    countBreached: vi.fn(),
    countByState: vi.fn(),
    countEscalated: vi.fn(),
    countRequested: vi.fn(),
  },
  advertisers: { applyKycDecision: vi.fn(), applyKycDecisionByUserId: vi.fn(), getAdvertiserForUser: vi.fn(), findAdvertiser: vi.fn() },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  digio: { initiateAdvertiserDigioKyc: vi.fn(), restartAdvertiserDigioKyc: vi.fn(), advertiserDigioStatus: vi.fn(), handleAdvertiserDigioWebhook: vi.fn() },
  settings: { getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })), getFlow: vi.fn(async () => ({ version: 7 })), ONBOARDING_FLOW_KEY: 'onboarding' },
  labels: {
    kycUserLabels: vi.fn(async () => new Map()),
    kycLabelFor: vi.fn(() => null),
    kycCaseExtras: vi.fn(async () => ({ ageHours: 1, slaBreached: false, slaHours: 48, reviewedBy: null, assignedTo: null, recordedBy: null, requestedBy: null, escalatedTo: null, escalatedBy: null })),
  },
  reviews: {
    recordDocumentReview: vi.fn(), flagDocuments: vi.fn(), flaggedDocuments: vi.fn(), listDocumentReviews: vi.fn(), listDocumentReviewsWithReviewer: vi.fn(async () => []), clearDocumentReviews: vi.fn(),
  },
}));

vi.mock('../prisma-advertiser-kyc.repository', () => ({ prismaAdvertiserKycRepository: repository }));
vi.mock('../../../advertisers', () => advertisers);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../advertiser-digio.service', () => digio);
vi.mock('../../../app-config', () => settings);
vi.mock('../../document-review/document-review.service', () => reviews);
vi.mock('../../user/user-kyc.service', () => ({ hasSubmittedLiveness: vi.fn(), livenessStateFor: vi.fn(async () => null) }));
vi.mock('../../escalation.service', () => ({ escalateKyc: vi.fn() }));
vi.mock('../../case-read', () => labels);

import { getAdvertiserKycCase, listAdvertiserKycs, resubmitAdvertiserKyc, updateAdvertiserKycById } from '../advertiser-kyc.service';
import { getAllAdvertiserKycsHandler } from '../advertiser-kyc.controller';
import { advertiserIdFilterSchema } from '../advertiser-kyc.schema';

const NOW = new Date('2026-09-14T09:00:00.000Z');
const row = {
  id: 'akyc_1',
  advertiserId: 'usr_adv',
  advertiserProfileId: 'adv_usr_adv',
  kycType: 'INDIVIDUAL',
  status: 'PENDING',
  method: 'MANUAL',
  submittedAt: null,
  requestedAt: null,
  requestedById: null,
  requestedChannel: null,
  recordedById: null,
  recordedVia: null,
  assignedToId: null,
};
const advertiserOf = (userId: string | null, type = 'INDIVIDUAL', id = `adv_${userId}`) => ({ id, userId, name: 'Meera S', companyName: null, email: 'meera@example.com', mobile: '+919876543210', type, kycStatus: 'PENDING' });
const PROFILES: Record<string, ReturnType<typeof advertiserOf>> = {
  adv_usr_adv: advertiserOf('usr_adv'),
  adv_usr_fresh: advertiserOf('usr_fresh', 'COMMERCIAL'),
  // N3-B: an advertiser ops created on the console today — no app account.
  adv_console: advertiserOf(null, 'COMMERCIAL', 'adv_console'),
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockImplementation(async (id: string) => (id === 'akyc_1' ? row : null));
  repository.findByAdvertiserId.mockImplementation(async (userId: string) => (userId === 'usr_adv' ? row : null));
  repository.findByProfileId.mockImplementation(async (profileId: string) => (profileId === 'adv_usr_adv' ? row : null));
  repository.updateById.mockImplementation(async (id: string, data: Record<string, unknown>, stamp?: Record<string, unknown>) => ({ ...row, id, ...data, ...(stamp ?? {}) }));
  repository.createAtDesk.mockImplementation(async (key: Record<string, unknown>, data: Record<string, unknown>, stamp: Record<string, unknown>) => ({
    ...row,
    id: 'akyc_new',
    ...key,
    ...data,
    recordedById: stamp['recordedById'],
    recordedVia: stamp['recordedVia'],
    method: stamp['method'],
    status: 'PENDING',
    submittedAt: stamp['at'],
  }));
  repository.resubmit.mockImplementation(async (key: Record<string, unknown>, data: Record<string, unknown>) => ({ ...row, ...key, ...data, status: 'PENDING', rejectionReason: null }));
  repository.pinManifestVersion.mockResolvedValue({ count: 1 });
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  repository.countBreached.mockResolvedValue(0);
  repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 0, VERIFIED: 0, REJECTED: 0, NEEDS_INFO: 0 });
  repository.countEscalated.mockResolvedValue(0);
  repository.countRequested.mockResolvedValue(0);
  advertisers.getAdvertiserForUser.mockImplementation(async (userId: string) =>
    userId === 'usr_adv' ? advertiserOf(userId) : userId === 'usr_fresh' ? advertiserOf(userId, 'COMMERCIAL') : null,
  );
  advertisers.findAdvertiser.mockImplementation(async (id: string) => PROFILES[id] ?? null);
});

describe('GET /advertiser-kyc/:id — the row id first, then the profile id, then the advertiser’s user id', () => {
  it('answers the case by the row id, by the profile id, by the user id, and 404s an id that is none of them', async () => {
    await expect(getAdvertiserKycCase('akyc_1', NOW)).resolves.toMatchObject({ id: 'akyc_1', advertiserId: 'usr_adv' });
    await expect(getAdvertiserKycCase('adv_usr_adv', NOW)).resolves.toMatchObject({ id: 'akyc_1', advertiserProfileId: 'adv_usr_adv' });
    await expect(getAdvertiserKycCase('usr_adv', NOW)).resolves.toMatchObject({ id: 'akyc_1', advertiserId: 'usr_adv' });
    expect(reviews.listDocumentReviewsWithReviewer).toHaveBeenLastCalledWith('ADVERTISER', 'akyc_1');
    await expect(getAdvertiserKycCase('usr_fresh', NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAdvertiserKycCase('adv_console', NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAdvertiserKycCase('nobody', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('N3-B: the resolution order is row id → profile id → user id — a profile id that is also somebody’s row id is read as the row', async () => {
    // The profile is tried before the user: a user id is never mistaken for a profile.
    await getAdvertiserKycCase('usr_adv', NOW);
    expect(advertisers.findAdvertiser).toHaveBeenCalledWith('usr_adv');
    expect(advertisers.getAdvertiserForUser).toHaveBeenCalledWith('usr_adv');
    expect(repository.findByProfileId).toHaveBeenCalledWith('adv_usr_adv');
  });
});

describe('PUT /advertiser-kyc/:id — the desk records over either id', () => {
  it('over a row id writes that row, as before', async () => {
    await updateAdvertiserKycById('akyc_1', { selfieUrl: 'https://x/s.png' }, 'usr_admin', undefined, NOW);
    expect(repository.updateById).toHaveBeenCalledWith('akyc_1', { selfieUrl: 'https://x/s.png' }, { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', at: NOW });
    expect(repository.createAtDesk).not.toHaveBeenCalled();
  });

  it('over the advertiser’s user id (or profile id) with a row writes that row — the row id is what the audit names', async () => {
    const result = await updateAdvertiserKycById('usr_adv', { panNumber: 'ABCDE1234F' }, 'usr_admin', undefined, NOW);
    expect(repository.updateById).toHaveBeenCalledWith('akyc_1', { panNumber: 'ABCDE1234F' }, expect.objectContaining({ recordedVia: 'DESK' }));
    expect(repository.createAtDesk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'akyc_1', recordedVia: 'DESK' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_KYC_RECORDED_AT_DESK', expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_1', metadata: expect.objectContaining({ advertiserId: 'usr_adv', advertiserProfileId: 'adv_usr_adv' }) }));

    await updateAdvertiserKycById('adv_usr_adv', { panNumber: 'ABCDE1234F' }, 'usr_admin', undefined, NOW);
    expect(repository.updateById).toHaveBeenLastCalledWith('akyc_1', { panNumber: 'ABCDE1234F' }, expect.objectContaining({ recordedVia: 'DESK' }));
  });

  it('over a user id with NO row creates it — keyed by the profile, PENDING, DESK, submittedAt, kycType from the advertiser’s entity type when the body names none — audits the new row and mirrors PENDING', async () => {
    const result = await updateAdvertiserKycById('usr_fresh', { govIdFrontUrl: 'https://x/front.png', manifestVersion: 3 }, 'usr_admin', undefined, NOW);
    expect(repository.updateById).not.toHaveBeenCalled();
    expect(repository.createAtDesk).toHaveBeenCalledWith(
      { advertiserProfileId: 'adv_usr_fresh', advertiserId: 'usr_fresh' },
      { kycType: 'COMMERCIAL', govIdFrontUrl: 'https://x/front.png' },
      { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', at: NOW },
    );
    expect(result).toMatchObject({ id: 'akyc_new', advertiserId: 'usr_fresh', advertiserProfileId: 'adv_usr_fresh', kycType: 'COMMERCIAL', status: 'PENDING', recordedVia: 'DESK', recordedById: 'usr_admin', submittedAt: NOW });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'ADVERTISER_KYC_RECORDED_AT_DESK',
      expect.objectContaining({ targetType: 'AdvertiserKyc', targetId: 'akyc_new', module: 'kyc', metadata: expect.objectContaining({ advertiserId: 'usr_fresh', advertiserProfileId: 'adv_usr_fresh', created: true }) }),
    );
    expect(advertisers.applyKycDecision).toHaveBeenCalledWith('adv_usr_fresh', 'PENDING');
  });

  it('N3-B: over a console-created profile with NO user creates the record with the profile alone (advertiserId null)', async () => {
    const result = await updateAdvertiserKycById('adv_console', { govIdFrontUrl: 'https://x/front.png' }, 'usr_admin', undefined, NOW);
    expect(repository.createAtDesk).toHaveBeenCalledWith(
      { advertiserProfileId: 'adv_console', advertiserId: null },
      { kycType: 'COMMERCIAL', govIdFrontUrl: 'https://x/front.png' },
      expect.objectContaining({ recordedVia: 'DESK' }),
    );
    expect(result).toMatchObject({ id: 'akyc_new', advertiserId: null, advertiserProfileId: 'adv_console', status: 'PENDING' });
    expect(advertisers.applyKycDecision).toHaveBeenCalledWith('adv_console', 'PENDING');
  });

  it('the body’s kycType wins over the entity type on a creation', async () => {
    await updateAdvertiserKycById('usr_fresh', { kycType: 'AGENCY', agencyAuthLetterUrl: 'https://x/a.png' }, 'usr_admin', undefined, NOW);
    expect(repository.createAtDesk).toHaveBeenCalledWith({ advertiserProfileId: 'adv_usr_fresh', advertiserId: 'usr_fresh' }, { kycType: 'AGENCY', agencyAuthLetterUrl: 'https://x/a.png' }, expect.anything());
  });

  it('is 404 for an id that is neither a row, a profile nor an advertiser’s user', async () => {
    await expect(updateAdvertiserKycById('nobody', { selfieUrl: 'https://x/s.png' }, 'usr_admin', undefined, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.updateById).not.toHaveBeenCalled();
    expect(repository.createAtDesk).not.toHaveBeenCalled();
  });

  it('refuses a VERIFIED record 409 KYC_ALREADY_VERIFIED — by the row id or the user id — before anything is written', async () => {
    const verified = { ...row, status: 'VERIFIED' };
    repository.findById.mockImplementation(async (id: string) => (id === 'akyc_1' ? verified : null));
    repository.findByAdvertiserId.mockImplementation(async (userId: string) => (userId === 'usr_adv' ? verified : null));
    repository.findByProfileId.mockImplementation(async (profileId: string) => (profileId === 'adv_usr_adv' ? verified : null));
    await expect(updateAdvertiserKycById('akyc_1', { selfieUrl: 'https://x/s.png' }, 'usr_admin', undefined, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    await expect(updateAdvertiserKycById('usr_adv', { selfieUrl: 'https://x/s.png' }, 'usr_admin', undefined, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(repository.updateById).not.toHaveBeenCalled();
    expect(repository.createAtDesk).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});

describe('PUT /advertiser-kyc/me — the advertiser’s own resubmission', () => {
  it('refuses a VERIFIED record 409 KYC_ALREADY_VERIFIED; nothing is written or pinned', async () => {
    repository.findByProfileId.mockResolvedValue({ ...row, status: 'VERIFIED' });
    await expect(resubmitAdvertiserKyc('usr_adv', { selfieUrl: 'https://x/s.png' })).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(repository.resubmit).not.toHaveBeenCalled();
    expect(repository.pinManifestVersion).not.toHaveBeenCalled();
    expect(reviews.clearDocumentReviews).not.toHaveBeenCalled();
  });

  it('still takes a resubmission once the desk has moved the record to NEEDS_INFO, and a first submission — N3-B: keyed by the caller’s profile, the mirror going PENDING', async () => {
    repository.findByProfileId.mockResolvedValue({ ...row, status: 'NEEDS_INFO' });
    await expect(resubmitAdvertiserKyc('usr_adv', { selfieUrl: 'https://x/s.png' })).resolves.toMatchObject({ status: 'PENDING' });
    expect(repository.resubmit).toHaveBeenLastCalledWith({ advertiserProfileId: 'adv_usr_adv', advertiserId: 'usr_adv' }, { selfieUrl: 'https://x/s.png' });
    expect(advertisers.applyKycDecision).toHaveBeenLastCalledWith('adv_usr_adv', 'PENDING');
    // A user with no profile (an account predating the model) keeps the legacy user key.
    repository.findByProfileId.mockResolvedValue(null);
    repository.findByAdvertiserId.mockResolvedValue(null);
    await expect(resubmitAdvertiserKyc('usr_new', { govIdFrontUrl: 'https://x/front.png' })).resolves.toMatchObject({ status: 'PENDING' });
    expect(repository.resubmit).toHaveBeenLastCalledWith({ advertiserProfileId: null, advertiserId: 'usr_new' }, { govIdFrontUrl: 'https://x/front.png' });
  });
});

describe('GET /advertiser-kyc?advertiserId= — one row or none', () => {
  it('the facet: a non-empty profile id or user id; blank is ignored', () => {
    expect(advertiserIdFilterSchema.parse(' usr_adv ')).toBe('usr_adv');
    expect(advertiserIdFilterSchema.safeParse('').success).toBe(false);
    expect(advertiserIdFilterSchema.parse(undefined)).toBeUndefined();
  });

  it('the service hands the facet to the repository as the row’s advertiserId', async () => {
    repository.findPage.mockResolvedValue({ items: [row], total: 1 });
    const page = await listAdvertiserKycs({ advertiserId: 'usr_adv' }, 1, 20, undefined, NOW);
    expect(repository.findPage).toHaveBeenCalledWith({ advertiserId: 'usr_adv' }, 1, 20, undefined);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'akyc_1', advertiserId: 'usr_adv' });
  });

  it('the handler reads ?advertiserId= beside the other facets and drops a blank one', async () => {
    const res = { json: vi.fn() } as never;
    await getAllAdvertiserKycsHandler({ query: { advertiserId: 'usr_adv', status: 'PENDING' }, user: { sub: 'usr_admin' } } as never, res);
    // N3-B: `status=` is the alias of `state=`.
    expect(repository.findPage).toHaveBeenLastCalledWith({ state: 'PENDING', advertiserId: 'usr_adv' }, 1, 20, undefined);

    await getAllAdvertiserKycsHandler({ query: { advertiserId: '' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({}, 1, 20, undefined);
  });

  it('N3-B: the handler reads ?state= (winning over the ?status= alias) and ?q=, and ignores an unknown state like it ignores an unknown status', async () => {
    const res = { json: vi.fn() } as never;
    await getAllAdvertiserKycsHandler({ query: { state: 'awaiting_documents', status: 'PENDING', q: ' Swiggy ' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({ state: 'AWAITING_DOCUMENTS', q: 'Swiggy' }, 1, 20, undefined);
    expect(repository.countByState).toHaveBeenLastCalledWith({ state: undefined, status: undefined, q: 'Swiggy' });
    await getAllAdvertiserKycsHandler({ query: { state: 'LOST' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({}, 1, 20, undefined);
  });
});
