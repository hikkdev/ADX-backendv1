import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot N — the print partner's KYC on three paths, and the desk that
 * reviews it.
 *
 * What is pinned: the partner's own submission stamps SELF and goes
 * PENDING, a NEEDS_INFO resubmission must carry a document
 * (EMPTY_RESUBMISSION) and clears the decisions on the fields sent, every
 * document must be the partner's own private PRINT_PARTNER_KYC file; the
 * desk's record stamps DESK and is audited; the desk's request stamps the
 * three request columns, opens Digio on the partner's behalf only for
 * DIGIO, tells the partner KYC_REQUESTED, is refused once verified; the
 * review needs the liveness proof on the manual path and tells the partner
 * KYC_DECISION; the per-document desk, the re-upload ask, assignment and
 * escalation mirror the advertiser's with PRINT_PARTNER_ audit names; the
 * queue answers the advertiser contract plus `requested`; the roster rows
 * carry the summary; the purge treats a Digio-path record like the others.
 */

type AnyFn = (...args: any[]) => any;

const { repository, partners, kyc, notifications, uploads, audit, digio } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn<AnyFn>(),
    countBreached: vi.fn<AnyFn>(async () => 1),
    countByState: vi.fn<AnyFn>(async () => ({ AWAITING_DOCUMENTS: 4, REQUESTED: 1, PENDING: 2, VERIFIED: 0, REJECTED: 0, NEEDS_INFO: 1 })),
    countEscalated: vi.fn<AnyFn>(async () => 1),
    countRequested: vi.fn<AnyFn>(async () => 1),
    findById: vi.fn<AnyFn>(),
    findByPartnerId: vi.fn<AnyFn>(),
    findByDigioRequestId: vi.fn<AnyFn>(),
    findSummaries: vi.fn<AnyFn>(async () => []),
    submit: vi.fn<AnyFn>(),
    review: vi.fn<AnyFn>(),
    requestReupload: vi.fn<AnyFn>(),
    assign: vi.fn<AnyFn>(async () => undefined),
    markRequested: vi.fn<AnyFn>(),
    upsertDigio: vi.fn<AnyFn>(),
    applyDigioWebhook: vi.fn<AnyFn>(),
    findPurgeable: vi.fn<AnyFn>(async () => []),
    purgeImages: vi.fn<AnyFn>(async () => ({})),
  },
  partners: { findPartner: vi.fn<AnyFn>() },
  kyc: {
    recordDocumentReview: vi.fn<AnyFn>(),
    flagDocuments: vi.fn<AnyFn>(async () => undefined),
    flaggedDocuments: vi.fn<AnyFn>(async () => [{ field: 'govIdFrontUrl', note: 'Blurry' }]),
    listDocumentReviewsWithReviewer: vi.fn<AnyFn>(async () => []),
    clearDocumentReviews: vi.fn<AnyFn>(async () => undefined),
    hasSubmittedLiveness: vi.fn<AnyFn>(async () => true),
    livenessStateFor: vi.fn<AnyFn>(async () => ({ id: 'ukyc_1', status: 'PENDING' })),
    kycCaseExtras: vi.fn<AnyFn>(async (row: { assignedToId?: string | null }) => ({
      ageHours: 5,
      slaBreached: false,
      slaHours: 48,
      reviewedBy: null,
      assignedTo: row?.assignedToId ? { id: row.assignedToId, name: 'Ops' } : null,
      recordedBy: null,
      escalatedTo: null,
      escalatedBy: null,
    })),
    kycUserLabels: vi.fn<AnyFn>(async (ids: (string | null)[]) => new Map(ids.filter(Boolean).map((id) => [id, { id, name: `name:${id}` }]))),
    kycLabelFor: (labels: Map<string, unknown>, id: string | null) => (id ? labels.get(id) ?? { id, name: null } : null),
    escalateKyc: vi.fn<AnyFn>(async () => ({ party: 'PRINT_PARTNER', kycId: 'ppk_1' })),
    maskPan: (pan: string | null) => (pan ? `******${pan.slice(-4)}` : null),
    trimDigioPayload: (payload: unknown) => (payload ? { trimmed: true } : null),
  },
  notifications: { createNotification: vi.fn<AnyFn>(async () => ({ id: 'ntf_1' })), notify: vi.fn<AnyFn>(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-decision', deliveries: [] })) },
  uploads: {
    findUploadedFile: vi.fn<AnyFn>(),
    purgeStoredFile: vi.fn<AnyFn>(async () => undefined),
    fileIdFromUrl: (url: string | null) => (url ? (/\/files\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null),
  },
  audit: { logActivity: vi.fn<AnyFn>(async () => undefined), auditDiff: vi.fn<AnyFn>(() => ({})) },
  digio: { initiatePrintPartnerDigioKyc: vi.fn<AnyFn>(async () => ({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://digio/#dg_1' })) },
}));

vi.mock('../prisma-print-partner-kyc.repository', () => ({ prismaPrintPartnerKycRepository: repository }));
vi.mock('../../prisma-print-partners.repository', () => ({ prismaPrintPartnersRepository: partners }));
vi.mock('../../../kyc', () => kyc);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../uploads', () => uploads);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2 } })) }));
vi.mock('../print-partner-digio.service', () => digio);

import {
  PRINT_PARTNER_KYC_DEEP_LINK,
  assertResubmissionCarriesDocuments,
  assignPrintPartnerCase,
  escalatePrintPartnerCase,
  getMyPrintPartnerKyc,
  getPrintPartnerKycCase,
  listPrintPartnerKycQueue,
  purgeVerifiedPrintPartnerImages,
  recordPrintPartnerKycAtDesk,
  requestPrintPartnerKyc,
  requestPrintPartnerReupload,
  reviewPrintPartnerDocument,
  reviewPrintPartnerKyc,
  submitMyPrintPartnerKyc,
  withKycSummary,
} from '../print-partner-kyc.service';

const NOW = new Date('2026-09-14T09:00:00.000Z');

const partner = { id: 'prt_1', userId: 'usr_prt', name: 'Sharma Prints', displayId: 'PRT-1409-2601', mobile: '+919999999999', email: 'shop@example.in', city: 'Pune', isActive: true, kycStatus: 'PENDING' } as any;
const slice = { id: 'prt_1', displayId: 'PRT-1409-2601', name: 'Sharma Prints', mobile: '+919999999999', email: 'shop@example.in', userId: 'usr_prt', city: 'Pune', isActive: true, kycStatus: 'PENDING' };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ppk_1',
  printPartnerId: 'prt_1',
  status: 'PENDING',
  method: 'MANUAL',
  submittedAt: new Date('2026-09-14T08:00:00.000Z'),
  rejectionReason: null,
  reviewNote: null,
  reviewedById: null,
  assignedToId: null,
  recordedById: 'usr_prt',
  recordedVia: 'SELF',
  requestedAt: null,
  requestedById: null,
  requestedChannel: null,
  escalatedAt: null,
  escalatedToUserId: null,
  escalatedById: null,
  panNumber: 'ABCDE1234F',
  govIdFrontUrl: 'https://adx.local/api/v1/files/f_front',
  digioVerifiedAt: null,
  digioPayload: null,
  printPartner: slice,
  ...over,
});

const file = (id: string, over: Record<string, unknown> = {}) => ({ id, userId: 'usr_prt', ownerUserId: null, purpose: 'PRINT_PARTNER_KYC', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  partners.findPartner.mockImplementation(async (id: string) => (id === 'prt_1' ? partner : null));
  repository.findById.mockImplementation(async (id: string) => (id === 'ppk_1' ? row() : null));
  repository.findByPartnerId.mockImplementation(async (id: string) => (id === 'prt_1' ? row() : null));
  repository.submit.mockImplementation(async (printPartnerId: string, data: object, stamp: object, at: Date) => row({ ...data, ...stamp, status: 'PENDING', submittedAt: at, rejectionReason: null }));
  repository.review.mockImplementation(async (_id: string, status: string, rejectionReason: string | null, stamp: object, at: Date) => row({ status, rejectionReason, reviewedAt: at, ...stamp }));
  repository.requestReupload.mockImplementation(async (_id: string, stamp: object) => row({ status: 'NEEDS_INFO', ...stamp }));
  repository.markRequested.mockImplementation(async (_id: string, stamp: object) => row({ ...stamp }));
  uploads.findUploadedFile.mockImplementation(async (id: string) => (id === 'f_front' || id === 'f_selfie' ? file(id) : null));
  kyc.hasSubmittedLiveness.mockResolvedValue(true);
});

describe('the partner on their own phone (SELF)', () => {
  it('a first submission goes PENDING with recordedVia SELF, the files checked, audited under the partner', async () => {
    const created = await submitMyPrintPartnerKyc(partner, { govIdFrontUrl: 'https://adx.local/api/v1/files/f_front', panNumber: 'ABCDE1234F' }, undefined, NOW);
    expect(repository.submit).toHaveBeenCalledWith('prt_1', { govIdFrontUrl: 'https://adx.local/api/v1/files/f_front', panNumber: 'ABCDE1234F' }, { recordedById: 'usr_prt', recordedVia: 'SELF', method: 'MANUAL' }, NOW);
    expect(created).toMatchObject({ status: 'PENDING', recordedVia: 'SELF', submittedAt: NOW });
    expect(kyc.clearDocumentReviews).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1', ['govIdFrontUrl']);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_prt', 'PRINT_PARTNER_KYC_SUBMITTED', expect.objectContaining({ targetType: 'PrintPartnerKyc', targetId: 'ppk_1', module: 'print-partners' }));
  });

  it('refuses a document that is not the partner\'s own private PRINT_PARTNER_KYC file', async () => {
    uploads.findUploadedFile.mockResolvedValueOnce(file('f_other', { userId: 'usr_someone_else' }));
    await expect(submitMyPrintPartnerKyc(partner, { selfieUrl: 'https://adx.local/api/v1/files/f_other' }, undefined, NOW)).rejects.toMatchObject({ statusCode: 404 });
    uploads.findUploadedFile.mockResolvedValueOnce(file('f_rc', { purpose: 'PARTNER_RATE_CARD' }));
    await expect(submitMyPrintPartnerKyc(partner, { selfieUrl: 'https://adx.local/api/v1/files/f_rc' }, undefined, NOW)).rejects.toMatchObject({ statusCode: 400 });
    // A public URL names no file at all.
    await expect(submitMyPrintPartnerKyc(partner, { selfieUrl: 'https://cdn.example/selfie.png' }, undefined, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it('while NEEDS_INFO a body naming no document is 400 EMPTY_RESUBMISSION; a flagged tile sent clears its decision and returns to PENDING', async () => {
    repository.findByPartnerId.mockResolvedValue(row({ status: 'NEEDS_INFO' }));
    await expect(submitMyPrintPartnerKyc(partner, { panNumber: 'ABCDE1234F' }, undefined, NOW)).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    expect(repository.submit).not.toHaveBeenCalled();

    const back = await submitMyPrintPartnerKyc(partner, { selfieUrl: 'https://adx.local/api/v1/files/f_selfie' }, undefined, NOW);
    expect(back.status).toBe('PENDING');
    expect(kyc.clearDocumentReviews).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1', ['selfieUrl']);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_prt', 'PRINT_PARTNER_KYC_SUBMITTED', expect.objectContaining({ metadata: expect.objectContaining({ resubmission: true }) }));
  });

  it('N2-B: a VERIFIED partner re-submitting is refused 409 KYC_ALREADY_VERIFIED — unless the desk has moved the record to NEEDS_INFO', async () => {
    repository.findByPartnerId.mockResolvedValue(row({ status: 'VERIFIED' }));
    await expect(submitMyPrintPartnerKyc(partner, { selfieUrl: 'https://adx.local/api/v1/files/f_selfie' }, undefined, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(repository.submit).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();

    repository.findByPartnerId.mockResolvedValue(row({ status: 'NEEDS_INFO' }));
    await expect(submitMyPrintPartnerKyc(partner, { selfieUrl: 'https://adx.local/api/v1/files/f_selfie' }, undefined, NOW)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('the rule stands on its own: only NEEDS_INFO asks for a document', () => {
    expect(() => assertResubmissionCarriesDocuments('PENDING', ['panNumber'])).not.toThrow();
    expect(() => assertResubmissionCarriesDocuments(undefined, [])).not.toThrow();
    expect(() => assertResubmissionCarriesDocuments('NEEDS_INFO', ['govIdType'])).toThrow();
    expect(() => assertResubmissionCarriesDocuments('NEEDS_INFO', ['bankProofUrl'])).not.toThrow();
  });

  it('GET /me/kyc answers the record with the flagged tiles, the liveness state and who asked; 404 before any record', async () => {
    repository.findByPartnerId.mockResolvedValue(row({ requestedById: 'usr_admin', requestedAt: NOW, requestedChannel: 'MANUAL' }));
    const mine = await getMyPrintPartnerKyc(partner);
    expect(mine).toMatchObject({ id: 'ppk_1', flagged: [{ field: 'govIdFrontUrl', note: 'Blurry' }], liveness: { id: 'ukyc_1' }, requestedBy: { id: 'usr_admin', name: 'name:usr_admin' } });
    expect((mine as Record<string, unknown>)['printPartner']).toBeUndefined();
    repository.findByPartnerId.mockResolvedValue(null);
    await expect(getMyPrintPartnerKyc(partner)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the desk recording it (DESK)', () => {
  it('writes the documents on the partner\'s behalf — recordedVia DESK, the admin\'s own upload accepted — and audits PRINT_PARTNER_KYC_RECORDED_AT_DESK', async () => {
    uploads.findUploadedFile.mockResolvedValueOnce(file('f_desk', { userId: 'usr_admin', ownerUserId: 'usr_prt' }));
    const result = await recordPrintPartnerKycAtDesk('ppk_1', { govIdBackUrl: 'https://adx.local/api/v1/files/f_desk' }, 'usr_admin', undefined, NOW);
    expect(repository.submit).toHaveBeenCalledWith('prt_1', { govIdBackUrl: 'https://adx.local/api/v1/files/f_desk' }, { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL' }, NOW);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_RECORDED_AT_DESK', expect.objectContaining({ targetType: 'PrintPartnerKyc', targetId: 'ppk_1', metadata: expect.objectContaining({ recordedVia: 'DESK', fields: ['govIdBackUrl'] }) }));
    expect(audit.auditDiff).toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'ppk_1', documentReviews: [], liveness: { id: 'ukyc_1' } });
  });

  it('takes the partner\'s id for a partner with no record yet and makes the record', async () => {
    repository.findByPartnerId.mockResolvedValueOnce(null).mockResolvedValue(row({ recordedVia: 'DESK', recordedById: 'usr_admin' }));
    repository.findById.mockResolvedValue(null);
    // The desk's read after the write resolves by the new record's id.
    repository.findById.mockImplementation(async (id: string) => (id === 'ppk_1' ? row({ recordedVia: 'DESK', recordedById: 'usr_admin' }) : null));
    uploads.findUploadedFile.mockResolvedValueOnce(file('f_desk', { userId: 'usr_admin' }));
    await recordPrintPartnerKycAtDesk('prt_1', { panFrontUrl: 'https://adx.local/api/v1/files/f_desk' }, 'usr_admin', undefined, NOW);
    expect(partners.findPartner).toHaveBeenCalledWith('prt_1');
    expect(repository.submit).toHaveBeenCalledWith('prt_1', expect.anything(), { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL' }, NOW);
  });

  it('an unknown id is 404', async () => {
    await expect(recordPrintPartnerKycAtDesk('nope', { panNumber: 'ABCDE1234F' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });

  it("N2-B: a VERIFIED record is refused 409 KYC_ALREADY_VERIFIED — by the record's id or the partner's — before anything is written", async () => {
    repository.findById.mockImplementation(async (id: string) => (id === 'ppk_1' ? row({ status: 'VERIFIED' }) : null));
    repository.findByPartnerId.mockImplementation(async (id: string) => (id === 'prt_1' ? row({ status: 'VERIFIED' }) : null));
    uploads.findUploadedFile.mockResolvedValue(file('f_desk', { userId: 'usr_admin', ownerUserId: 'usr_prt' }));
    await expect(recordPrintPartnerKycAtDesk('ppk_1', { govIdBackUrl: 'https://adx.local/api/v1/files/f_desk' }, 'usr_admin', undefined, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    await expect(recordPrintPartnerKycAtDesk('prt_1', { govIdBackUrl: 'https://adx.local/api/v1/files/f_desk' }, 'usr_admin', undefined, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(repository.submit).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});

describe('the desk asking for it (the request)', () => {
  it('MANUAL: stamps who, when and the channel, tells the partner KYC_REQUESTED with the note and the deep link, audits; no Digio', async () => {
    const result = await requestPrintPartnerKyc('prt_1', { channel: 'MANUAL', note: 'Bring the GST certificate too' }, 'usr_admin', undefined, NOW);
    expect(repository.markRequested).toHaveBeenCalledWith('prt_1', { requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'MANUAL' });
    expect(digio.initiatePrintPartnerDigioKyc).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      'KYC_REQUESTED',
      'usr_prt',
      { partyName: 'Sharma Prints', channel: 'document upload', note: 'Bring the GST certificate too', deepLink: PRINT_PARTNER_KYC_DEEP_LINK },
      expect.objectContaining({ inApp: expect.objectContaining({ type: 'KYC', relatedId: 'ppk_1', message: expect.stringContaining('Bring the GST certificate too') }) }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_REQUESTED', expect.objectContaining({ targetType: 'PrintPartnerKyc', metadata: expect.objectContaining({ channel: 'MANUAL', note: 'Bring the GST certificate too', digioKycId: null }) }));
    expect(result.digio).toBeNull();
  });

  it('DIGIO: opens the session on the partner\'s behalf (the link goes to the partner) and answers its id', async () => {
    const result = await requestPrintPartnerKyc('ppk_1', { channel: 'DIGIO' }, 'usr_admin', undefined, NOW);
    expect(digio.initiatePrintPartnerDigioKyc).toHaveBeenCalledWith(partner, { onBehalf: true }, NOW);
    expect(notifications.notify).toHaveBeenCalledWith('KYC_REQUESTED', 'usr_prt', expect.objectContaining({ channel: 'Digio', note: '' }), expect.anything());
    expect(result.digio).toEqual({ kycId: 'dg_1', validTill: '2026-09-15T00:00:00.000Z' });
  });

  it('is refused 409 KYC_ALREADY_VERIFIED on a verified record', async () => {
    repository.findById.mockResolvedValue(row({ status: 'VERIFIED' }));
    await expect(requestPrintPartnerKyc('ppk_1', { channel: 'DIGIO' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(repository.markRequested).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('the decision', () => {
  it('VERIFIED on the manual path needs the liveness proof on the partner\'s user; the Digio path is exempt', async () => {
    kyc.hasSubmittedLiveness.mockResolvedValue(false);
    await expect(reviewPrintPartnerKyc('ppk_1', { status: 'VERIFIED' }, { userId: 'usr_admin' }, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'LIVENESS_REQUIRED' });
    expect(kyc.hasSubmittedLiveness).toHaveBeenCalledWith('usr_prt');
    expect(repository.review).not.toHaveBeenCalled();

    repository.findById.mockResolvedValue(row({ method: 'DIGIO' }));
    await expect(reviewPrintPartnerKyc('ppk_1', { status: 'VERIFIED' }, { userId: 'usr_admin' }, NOW)).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it('documents uploaded by hand after a desk Digio request that never finished put the row back on the manual path, so the gate applies (verifier)', async () => {
    // The desk asked on Digio: the row is method DIGIO, digioStatus pending, nothing back.
    repository.findByPartnerId.mockResolvedValue(row({ method: 'DIGIO', digioStatus: 'pending', submittedAt: null, requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO' }));
    const submitted = await submitMyPrintPartnerKyc(partner, { govIdFrontUrl: 'https://adx.local/api/v1/files/f_front' }, undefined, NOW);
    expect(repository.submit).toHaveBeenCalledWith('prt_1', expect.anything(), expect.objectContaining({ method: 'MANUAL' }), NOW);
    expect(submitted.method).toBe('MANUAL');

    kyc.hasSubmittedLiveness.mockResolvedValue(false);
    repository.findById.mockResolvedValue(submitted);
    await expect(reviewPrintPartnerKyc('ppk_1', { status: 'VERIFIED' }, { userId: 'usr_admin' }, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'LIVENESS_REQUIRED' });
  });

  it('stamps who and what, audits PRINT_PARTNER_KYC_REVIEWED with a diff, tells the partner KYC_DECISION either way', async () => {
    const verified = await reviewPrintPartnerKyc('ppk_1', { status: 'VERIFIED', reviewNote: 'All good' }, { userId: 'usr_admin' }, NOW);
    expect(repository.review).toHaveBeenCalledWith('ppk_1', 'VERIFIED', null, { reviewedById: 'usr_admin', reviewNote: 'All good' }, NOW);
    expect(verified).toMatchObject({ status: 'VERIFIED', reviewedById: 'usr_admin' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_REVIEWED', expect.objectContaining({ targetType: 'PrintPartnerKyc', targetId: 'ppk_1' }));
    expect(audit.auditDiff).toHaveBeenCalledWith(expect.anything(), expect.anything(), ['status', 'rejectionReason', 'reviewNote']);
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_prt', expect.objectContaining({ partyName: 'Sharma Prints', decision: 'verified' }), expect.objectContaining({ inApp: expect.objectContaining({ type: 'KYC' }) }));

    vi.clearAllMocks();
    repository.findById.mockResolvedValue(row());
    await reviewPrintPartnerKyc('ppk_1', { status: 'REJECTED', rejectionReason: 'PAN does not match the GSTIN' }, { userId: 'usr_admin' }, NOW);
    expect(repository.review).toHaveBeenCalledWith('ppk_1', 'REJECTED', 'PAN does not match the GSTIN', expect.anything(), NOW);
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_prt', expect.objectContaining({ decision: 'not verified', reason: 'PAN does not match the GSTIN' }), expect.anything());
  });
});

describe('the per-document desk', () => {
  it('records one tile with party type PRINT_PARTNER and audits; an unknown field is 400', async () => {
    kyc.recordDocumentReview.mockResolvedValue({ id: 'rev_1', field: 'govIdFrontUrl', decision: 'FLAGGED' });
    await expect(reviewPrintPartnerDocument('ppk_1', 'govIdFrontUrl', { decision: 'FLAGGED', note: 'Blurry' }, 'usr_admin')).resolves.toMatchObject({ field: 'govIdFrontUrl' });
    expect(kyc.recordDocumentReview).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1', { field: 'govIdFrontUrl', decision: 'FLAGGED', note: 'Blurry' }, 'usr_admin');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_DOCUMENT_REVIEWED', expect.objectContaining({ targetType: 'PrintPartnerKyc', targetId: 'ppk_1' }));
    await expect(reviewPrintPartnerDocument('ppk_1', 'panNumber', { decision: 'APPROVED' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    await expect(reviewPrintPartnerDocument('ppk_1', 'aadhaarFrontUrl', { decision: 'APPROVED' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a re-upload ask flags, goes NEEDS_INFO, tells the partner which tiles, audits; refused once verified', async () => {
    const result = await requestPrintPartnerReupload('ppk_1', { fields: ['govIdFrontUrl'], note: 'Blurry' }, 'usr_admin', undefined, NOW);
    expect(kyc.flagDocuments).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1', ['govIdFrontUrl'], 'Blurry', 'usr_admin');
    expect(repository.requestReupload).toHaveBeenCalledWith('ppk_1', { reviewedById: 'usr_admin', reviewNote: 'Blurry' }, NOW);
    expect(result).toMatchObject({ status: 'NEEDS_INFO', flagged: [{ field: 'govIdFrontUrl', note: 'Blurry' }] });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_prt', type: 'KYC', suggestedAction: 'Re-upload the flagged documents', message: expect.stringContaining('govIdFrontUrl') }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_REUPLOAD_REQUESTED', expect.anything());

    repository.findById.mockResolvedValue(row({ status: 'VERIFIED' }));
    await expect(requestPrintPartnerReupload('ppk_1', { fields: ['selfieUrl'], note: 'x' }, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('assignment and escalation', () => {
  it('assignment is a filter: `me` resolves to the caller, null clears; audited PRINT_PARTNER_KYC_ASSIGNED; the case answers', async () => {
    repository.findById.mockResolvedValueOnce(row()).mockResolvedValue(row({ assignedToId: 'usr_admin' }));
    const result = await assignPrintPartnerCase('ppk_1', { adminUserId: 'me' }, 'usr_admin', undefined, NOW);
    expect(repository.assign).toHaveBeenCalledWith('ppk_1', 'usr_admin', NOW);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_ASSIGNED', expect.objectContaining({ targetType: 'PrintPartnerKyc' }));
    expect(result.assignedTo).toEqual({ id: 'usr_admin', name: 'Ops' });
    await assignPrintPartnerCase('ppk_1', { adminUserId: null }, 'usr_admin', undefined, NOW);
    expect(repository.assign).toHaveBeenLastCalledWith('ppk_1', null, NOW);
  });

  it('escalation hands the case to kyc with party PRINT_PARTNER and answers the case', async () => {
    const result = await escalatePrintPartnerCase('ppk_1', { reason: 'PAN looks altered' }, 'usr_admin', undefined, NOW);
    expect(kyc.escalateKyc).toHaveBeenCalledWith({ party: 'PRINT_PARTNER', kycId: 'ppk_1' }, { reason: 'PAN looks altered', byUserId: 'usr_admin', req: undefined }, NOW);
    expect(result).toMatchObject({ id: 'ppk_1', ageHours: 5 });
  });
});

describe('the queue and the case', () => {
  it('answers the advertiser contract — items with age, names and `requested`; counts, breached, escalated, requested, slaHours', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        row({ submittedAt: new Date('2026-09-10T09:00:00.000Z'), assignedToId: 'usr_ops', requestedById: 'usr_admin' }),
        row({ id: 'ppk_2', status: 'PENDING', submittedAt: null, requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO', recordedById: null }),
      ],
      total: 2,
    });
    const page = await listPrintPartnerKycQueue({ requested: true }, 1, 20, undefined, NOW);
    expect(repository.findPage).toHaveBeenCalledWith({ requested: true }, 1, 20, undefined);
    // N3-B: the chips are parties per state, the state facet (and its alias) removed.
    expect(repository.countByState).toHaveBeenCalledWith({ requested: true, state: undefined, status: undefined });
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20, breached: 1, escalated: 1, requested: 1, slaHours: 48, counts: { AWAITING_DOCUMENTS: 4, awaitingDocuments: 4, REQUESTED: 1, PENDING: 2, NEEDS_INFO: 1, escalated: 1, requested: 1 } });
    expect(page.items[0]).toMatchObject({ ageHours: 96, slaBreached: true, requested: false, assignedTo: { id: 'usr_ops', name: 'name:usr_ops' }, requestedBy: { id: 'usr_admin', name: 'name:usr_admin' }, recordedBy: { id: 'usr_prt' } });
    expect(page.items[1]).toMatchObject({ ageHours: null, slaBreached: false, requested: true, recordedBy: null });
  });

  it('the case carries the decisions, the liveness, the SLA and the people — requestedBy included; both ids resolve', async () => {
    kyc.listDocumentReviewsWithReviewer.mockResolvedValue([{ field: 'govIdFrontUrl', decision: 'FLAGGED', reviewedBy: { id: 'usr_admin', name: null } }]);
    repository.findById.mockResolvedValue(row({ requestedById: 'usr_admin', requestedAt: NOW, submittedAt: null }));
    const byRecord = await getPrintPartnerKycCase('ppk_1', NOW);
    expect(kyc.listDocumentReviewsWithReviewer).toHaveBeenCalledWith('PRINT_PARTNER', 'ppk_1');
    expect(kyc.livenessStateFor).toHaveBeenCalledWith('usr_prt');
    expect(byRecord).toMatchObject({ documentReviews: [{ field: 'govIdFrontUrl' }], liveness: { id: 'ukyc_1' }, slaHours: 48, requested: true, requestedBy: { id: 'usr_admin', name: 'name:usr_admin' }, printPartner: { name: 'Sharma Prints' } });

    repository.findById.mockResolvedValue(null);
    const byPartner = await getPrintPartnerKycCase('prt_1', NOW);
    expect(byPartner.id).toBe('ppk_1');
    await expect(getPrintPartnerKycCase('nope', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("the roster rows and the partner's own read carry the summary — requestedChannel included (N2-B); N3-B: `state` and `kycId` beside it, AWAITING_DOCUMENTS before any record", async () => {
    repository.findSummaries.mockResolvedValue([{ id: 'ppk_1', printPartnerId: 'prt_1', status: 'NEEDS_INFO', submittedAt: NOW, method: 'MANUAL', requestedAt: NOW, requestedChannel: 'DIGIO' }]);
    const rows = await withKycSummary([{ id: 'prt_1', kycStatus: 'NEEDS_INFO' }, { id: 'prt_2', kycStatus: 'PENDING' }, { id: 'prt_3', kycStatus: 'VERIFIED' }]);
    expect(repository.findSummaries).toHaveBeenCalledWith(['prt_1', 'prt_2', 'prt_3']);
    expect(rows[0]!.kyc).toEqual({ state: 'NEEDS_INFO', kycId: 'ppk_1', status: 'NEEDS_INFO', submittedAt: NOW, method: 'MANUAL', requestedAt: NOW, requestedChannel: 'DIGIO' });
    expect(rows[1]!.kyc).toEqual({ state: 'AWAITING_DOCUMENTS', kycId: null, status: null, submittedAt: null, method: null, requestedAt: null, requestedChannel: null });
    // A verified mirror with no record (a legacy row) reads VERIFIED, as the queue would list it.
    expect(rows[2]!.kyc).toMatchObject({ state: 'VERIFIED', kycId: null });
  });
});

describe('the purge', () => {
  it('removes the private files of a Digio-path record, masks and trims, audits KYC_IMAGES_PURGED against the record', async () => {
    repository.findPurgeable.mockResolvedValue([
      row({ method: 'DIGIO', status: 'VERIFIED', digioVerifiedAt: new Date('2026-08-01T00:00:00.000Z'), selfieUrl: 'https://cdn.example/legacy.png', bankProofUrl: 'https://adx.local/api/v1/files/f_bank', digioPayload: { id: 'dg_1', status: 'approved' } }),
    ]);
    const cutoff = new Date('2026-08-15T00:00:00.000Z');
    await expect(purgeVerifiedPrintPartnerImages(cutoff, 'usr_system')).resolves.toEqual(['ppk_1']);
    expect(repository.findPurgeable).toHaveBeenCalledWith(cutoff, 200);
    expect(uploads.purgeStoredFile).toHaveBeenCalledTimes(2);
    expect(uploads.purgeStoredFile).toHaveBeenCalledWith('f_front');
    expect(uploads.purgeStoredFile).toHaveBeenCalledWith('f_bank');
    expect(repository.purgeImages).toHaveBeenCalledWith('ppk_1', { panNumber: '******234F', digioPayload: { trimmed: true } });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_system', 'KYC_IMAGES_PURGED', expect.objectContaining({ targetType: 'PrintPartnerKyc', targetId: 'ppk_1', module: 'print-partners' }));
  });

  it('asks the repository only for Digio-path rows — the manual path is never touched', async () => {
    repository.findPurgeable.mockResolvedValue([]);
    await expect(purgeVerifiedPrintPartnerImages(NOW, 'usr_system')).resolves.toEqual([]);
    expect(repository.purgeImages).not.toHaveBeenCalled();
  });
});
