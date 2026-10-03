import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot N — Digio for a print partner.
 *
 * What is pinned: the partner's own initiate opens the shared client's
 * session under an `adx-pp-` reference and stamps the row DIGIO/pending
 * with `submittedAt`; a desk-side initiate leaves `submittedAt` for the
 * webhook; the webhook is claimed by the request id and lands on the
 * partner's row with `recordedVia: DIGIO`, a decision and the mirror, and
 * tells the partner KYC_DECISION; a request id nobody holds is declined;
 * the desk's restart is refused once verified, audited, and tells the
 * partner.
 */

type AnyFn = (...args: any[]) => any;

const { repository, digio, notifications, audit } = vi.hoisted(() => ({
  repository: {
    upsertDigio: vi.fn<AnyFn>(),
    setEntityType: vi.fn<AnyFn>(),
    reopenDigioForUpgrade: vi.fn<AnyFn>(),
    findByPartnerId: vi.fn<AnyFn>(),
    findByDigioRequestId: vi.fn<AnyFn>(),
    applyDigioWebhook: vi.fn<AnyFn>(),
  },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
  notifications: { createNotification: vi.fn<AnyFn>(async () => ({ id: 'ntf_1' })), notify: vi.fn<AnyFn>(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-decision', deliveries: [] })) },
  audit: { logActivity: vi.fn<AnyFn>(async () => undefined), auditDiff: (before: Record<string, unknown>, after: Record<string, unknown>) => ({ before, after }) },
}));

vi.mock('../prisma-print-partner-kyc.repository', () => ({ prismaPrintPartnerKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../../shared/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  DIGIO_REFERENCE_PREFIX,
  editPrintPartnerEntityType,
  handlePrintPartnerDigioWebhook,
  initiatePrintPartnerDigioKyc,
  noteEntityTypeForManualRequest,
  printPartnerDigioStatus,
  restartPrintPartnerDigioKyc,
  type DigioPartner,
} from '../print-partner-digio.service';

const NOW = new Date('2026-09-14T09:00:00.000Z');
// Phase D: a shop has no legacy type to read its legal form from — it is stored, or asked.
const partner: DigioPartner = { id: 'prt_1', name: 'Sharma Prints', email: 'shop@example.in', mobile: '+919999999999', entityType: 'SOLE_PROPRIETOR', kycStatus: 'PENDING' };
const unknown: DigioPartner = { ...partner, entityType: null };
const slice = { id: 'prt_1', displayId: 'PRT-1409-2601', name: 'Sharma Prints', mobile: '+919999999999', email: 'shop@example.in', userId: 'usr_prt', city: 'Pune', isActive: true, kycStatus: 'PENDING', entityType: 'SOLE_PROPRIETOR' };
const self = { onBehalf: false, byUserId: 'usr_prt' };
const desk = { onBehalf: true, byUserId: 'usr_admin' };
const row = (over: Record<string, unknown> = {}) => ({ id: 'ppk_1', printPartnerId: 'prt_1', status: 'PENDING', method: 'DIGIO', digioRequestId: 'dg_1', digioStatus: 'pending', submittedAt: null, digioVerifiedAt: null, printPartner: slice, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_1?token=tok', mock: false });
  repository.upsertDigio.mockImplementation(async (_id: string, fields: Record<string, unknown>) => row(fields));
  repository.applyDigioWebhook.mockImplementation(async (_id: string, update: Record<string, unknown>) => row(update));
  repository.findByPartnerId.mockResolvedValue(null);
});

describe('initiate', () => {
  it('from the partner\'s phone: the shared client under an adx-pp- reference, the row DIGIO/pending with submittedAt', async () => {
    const session = await initiatePrintPartnerDigioKyc(partner, self, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith({ party: 'PRINT_PARTNER', workflowKey: 'PRINT_PARTNER.SOLE_PROPRIETOR', referenceId: `${DIGIO_REFERENCE_PREFIX}prt_1-${NOW.getTime()}`, customerName: 'Sharma Prints', customerEmail: 'shop@example.in', customerMobile: '+919999999999' });
    expect(repository.upsertDigio).toHaveBeenCalledWith('prt_1', { method: 'DIGIO', digioRequestId: 'dg_1', digioReferenceId: expect.stringMatching(/^adx-pp-prt_1-/), digioStatus: 'pending', submittedAt: NOW });
    expect(session).toEqual({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_1?token=tok' });
  });

  it('on the desk\'s behalf: the same session, submittedAt left for the webhook (the queue\'s "requested" facet)', async () => {
    await initiatePrintPartnerDigioKyc(partner, desk, NOW);
    expect(repository.upsertDigio).toHaveBeenCalledWith('prt_1', { method: 'DIGIO', digioRequestId: 'dg_1', digioReferenceId: expect.any(String), digioStatus: 'pending' });
  });

  it('Phase D: is 409 ENTITY_TYPE_REQUIRED with the four options when the shop’s legal form is unknown — nothing stored, Digio not asked', async () => {
    await expect(initiatePrintPartnerDigioKyc(unknown, self, NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ENTITY_TYPE_REQUIRED',
      details: {
        party: 'PRINT_PARTNER',
        options: [
          { value: 'INDIVIDUAL', label: 'Individual' },
          { value: 'SOLE_PROPRIETOR', label: 'Sole proprietor' },
          { value: 'COMPANY', label: 'Company' },
          { value: 'LLP_PARTNERSHIP', label: 'LLP or partnership' },
        ],
      },
    });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.setEntityType).not.toHaveBeenCalled();
    expect(repository.upsertDigio).not.toHaveBeenCalled();
  });

  it('Phase D: stores the sent form and audits it, then asks Digio on that workflow; a form a shop may not take is 400', async () => {
    await initiatePrintPartnerDigioKyc(unknown, { ...self, entityType: 'COMPANY' }, NOW);
    expect(repository.setEntityType).toHaveBeenCalledWith('prt_1', 'COMPANY');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_prt', 'KYC_ENTITY_TYPE_SET', expect.objectContaining({ targetType: 'PrintPartner', targetId: 'prt_1', diff: { before: { entityType: null }, after: { entityType: 'COMPANY' } } }));
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'PRINT_PARTNER.COMPANY' }));

    vi.clearAllMocks();
    await expect(initiatePrintPartnerDigioKyc(unknown, { ...self, entityType: 'NON_PROFIT' }, NOW)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(initiatePrintPartnerDigioKyc(unknown, { ...self, entityType: 'POLITICAL' }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.setEntityType).not.toHaveBeenCalled();
  });

  it('Phase D, the upgrade: a verified individual verifying as a sole proprietor reopens the record and the mirror on the new request', async () => {
    repository.findByPartnerId.mockResolvedValue(row({ status: 'VERIFIED', digioRequestId: 'dg_old', digioPayload: { id: 'dg_old', status: 'approved', kyc_documents: [{ type: 'PAN', status: 'approved', id_number: 'ABCDE1234F' }] } }));
    const individual: DigioPartner = { ...partner, entityType: 'INDIVIDUAL', kycStatus: 'VERIFIED' };
    await initiatePrintPartnerDigioKyc(individual, { ...desk, entityType: 'SOLE_PROPRIETOR' }, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'PRINT_PARTNER.SOLE_PROPRIETOR' }));
    expect(repository.reopenDigioForUpgrade).toHaveBeenCalledWith('prt_1', 'SOLE_PROPRIETOR', expect.objectContaining({ digioRequestId: 'dg_1', digioStatus: 'pending' }));
    expect(repository.upsertDigio).not.toHaveBeenCalled();
    const upgraded = audit.logActivity.mock.calls.find((call) => call[1] === 'KYC_ENTITY_UPGRADED') as [string, string, { diff: { before: Record<string, unknown>; after: Record<string, unknown> } }];
    expect(upgraded[2].diff.before).toMatchObject({ entityType: 'INDIVIDUAL', status: 'VERIFIED', digioRequestId: 'dg_old', digioPayload: { trimmed: true } });
    expect(upgraded[2].diff.after).toMatchObject({ entityType: 'SOLE_PROPRIETOR', status: 'PENDING', digioRequestId: 'dg_1' });
    expect(JSON.stringify(upgraded[2].diff)).not.toContain('ABCDE1234F');

    // Any other change on a verified shop is the old 409, Digio not asked again.
    vi.clearAllMocks();
    repository.findByPartnerId.mockResolvedValue(row({ status: 'VERIFIED' }));
    await expect(initiatePrintPartnerDigioKyc({ ...partner, entityType: 'COMPANY', kycStatus: 'VERIFIED' }, { ...desk, entityType: 'LLP_PARTNERSHIP' }, NOW)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
  });

  it('Phase D: a manual desk request stores a sent form and asks nothing when none is sent', async () => {
    await noteEntityTypeForManualRequest(unknown, desk);
    expect(repository.setEntityType).not.toHaveBeenCalled();
    await noteEntityTypeForManualRequest(unknown, { ...desk, entityType: 'LLP_PARTNERSHIP' });
    expect(repository.setEntityType).toHaveBeenCalledWith('prt_1', 'LLP_PARTNERSHIP');
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
  });

  it('the status read answers the four Digio facts, null before any record', async () => {
    repository.findByPartnerId.mockResolvedValue(row({ digioVerifiedAt: NOW, status: 'VERIFIED', digioStatus: 'approved' }));
    await expect(printPartnerDigioStatus('prt_1')).resolves.toEqual({ method: 'DIGIO', digioStatus: 'approved', kycStatus: 'VERIFIED', digioVerifiedAt: NOW });
    repository.findByPartnerId.mockResolvedValue(null);
    await expect(printPartnerDigioStatus('prt_1')).resolves.toBeNull();
  });
});

describe('the webhook', () => {
  it('declines a request id no partner row holds', async () => {
    repository.findByDigioRequestId.mockResolvedValue(null);
    await expect(handlePrintPartnerDigioWebhook({ id: 'dg_x', customer_identifier: 'x', status: 'approved' }, NOW)).resolves.toBe(false);
    expect(repository.applyDigioWebhook).not.toHaveBeenCalled();
  });

  it('an approval lands on the partner\'s row — VERIFIED, recordedVia DIGIO, submittedAt filled from the desk\'s request — and tells the partner KYC_DECISION', async () => {
    repository.findByDigioRequestId.mockResolvedValue(row());
    const payload = { id: 'dg_1', customer_identifier: 'shop@example.in', status: 'approved' as const, completed_at: '2026-09-14T08:30:00.000Z' };
    await expect(handlePrintPartnerDigioWebhook(payload, NOW)).resolves.toBe(true);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('ppk_1', {
      digioStatus: 'approved',
      digioPayload: payload,
      digioVerifiedAt: new Date('2026-09-14T08:30:00.000Z'),
      status: 'VERIFIED',
      reviewedAt: NOW,
      rejectionReason: undefined,
      submittedAt: new Date('2026-09-14T08:30:00.000Z'),
      recordedVia: 'DIGIO',
    });
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_prt', { partyName: 'Sharma Prints', decision: 'verified', reason: 'Your shop can be paid for print jobs.' }, expect.objectContaining({ inApp: expect.objectContaining({ type: 'KYC', relatedId: 'ppk_1' }) }));
  });

  it('a rejection carries Digio\'s message as the reason; a pending update only tells the partner in-app', async () => {
    repository.findByDigioRequestId.mockResolvedValue(row({ submittedAt: new Date('2026-09-14T07:00:00.000Z') }));
    await handlePrintPartnerDigioWebhook({ id: 'dg_1', customer_identifier: 'x', status: 'rejected', message: 'Face mismatch' }, NOW);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('ppk_1', expect.objectContaining({ status: 'REJECTED', rejectionReason: 'Face mismatch', submittedAt: new Date('2026-09-14T07:00:00.000Z'), recordedVia: 'DIGIO' }));
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_prt', expect.objectContaining({ decision: 'not verified', reason: 'Face mismatch' }), expect.anything());

    vi.clearAllMocks();
    repository.findByDigioRequestId.mockResolvedValue(row());
    repository.applyDigioWebhook.mockResolvedValue(row());
    await handlePrintPartnerDigioWebhook({ id: 'dg_1', customer_identifier: 'x', status: 'pending' }, NOW);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('ppk_1', expect.objectContaining({ status: 'PENDING', reviewedAt: undefined }));
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_prt', type: 'KYC' }));
  });

  it('Phase D: a pending or unknown status never moves a VERIFIED or REJECTED record back; on an open one it is kept raw', async () => {
    for (const status of ['VERIFIED', 'REJECTED']) {
      repository.findByDigioRequestId.mockResolvedValue(row({ status }));
      for (const sent of ['pending', 'cancelled', 'approval_pending']) {
        await expect(handlePrintPartnerDigioWebhook({ id: 'dg_1', status: sent }, NOW)).resolves.toBe(true);
      }
    }
    expect(repository.applyDigioWebhook).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();

    repository.findByDigioRequestId.mockResolvedValue(row());
    await handlePrintPartnerDigioWebhook({ id: 'dg_1', status: 'approval_pending' }, NOW);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('ppk_1', expect.objectContaining({ digioStatus: 'approval_pending', status: 'PENDING' }));
  });
});

describe('the desk\'s restart', () => {
  it('opens a fresh session on the partner\'s behalf, audits PRINT_PARTNER_KYC_DIGIO_RESTARTED, tells the partner; 409 once verified', async () => {
    const result = await restartPrintPartnerDigioKyc(row() as any, 'usr_admin');
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ customerName: 'Sharma Prints', customerMobile: '+919999999999' }));
    expect(repository.upsertDigio).toHaveBeenCalledWith('prt_1', expect.not.objectContaining({ submittedAt: expect.anything() }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_KYC_DIGIO_RESTARTED', expect.objectContaining({ targetType: 'PrintPartnerKyc', targetId: 'ppk_1', metadata: expect.objectContaining({ kycId: 'dg_1' }) }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_prt', type: 'KYC', relatedId: 'ppk_1' }));
    expect(result).toEqual({ kycId: 'dg_1', validTill: '2026-09-15T00:00:00.000Z', digioStatus: 'pending', notified: true });

    await expect(restartPrintPartnerDigioKyc(row({ status: 'VERIFIED' }) as any, 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('Phase D: restarts a verified individual only as the upgrade to a business form', async () => {
    const verified = row({ status: 'VERIFIED', printPartner: { ...slice, entityType: 'INDIVIDUAL', kycStatus: 'VERIFIED' } });
    repository.findByPartnerId.mockResolvedValue(verified);
    await expect(restartPrintPartnerDigioKyc(verified as any, 'usr_admin', undefined, { entityType: 'INDIVIDUAL' })).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    await restartPrintPartnerDigioKyc(verified as any, 'usr_admin', undefined, { entityType: 'COMPANY' });
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'PRINT_PARTNER.COMPANY' }));
    expect(repository.reopenDigioForUpgrade).toHaveBeenCalledWith('prt_1', 'COMPANY', expect.anything());
  });
});

describe('Phase D: the Edit-details drawer', () => {
  it('stores and clears the form on an unverified shop, audited KYC_ENTITY_TYPE_SET; Digio is not asked', async () => {
    await editPrintPartnerEntityType(unknown, 'COMPANY', { byUserId: 'usr_admin' });
    expect(repository.setEntityType).toHaveBeenLastCalledWith('prt_1', 'COMPANY');
    await editPrintPartnerEntityType(partner, null, { byUserId: 'usr_admin' });
    expect(repository.setEntityType).toHaveBeenLastCalledWith('prt_1', null);
    expect(audit.logActivity).toHaveBeenLastCalledWith('usr_admin', 'KYC_ENTITY_TYPE_SET', expect.objectContaining({ diff: { before: { entityType: 'SOLE_PROPRIETOR' }, after: { entityType: null } }, metadata: { party: 'PRINT_PARTNER', at: 'EDIT' } }));
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
  });

  it('on a verified shop: only the upgrade (a fresh Digio request); anything else is 409 KYC_LOCKED', async () => {
    await expect(editPrintPartnerEntityType({ ...partner, kycStatus: 'VERIFIED' }, 'COMPANY', { byUserId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409, code: 'KYC_LOCKED' });
    expect(repository.setEntityType).not.toHaveBeenCalled();

    repository.findByPartnerId.mockResolvedValue(row({ status: 'VERIFIED' }));
    await editPrintPartnerEntityType({ ...partner, entityType: 'INDIVIDUAL', kycStatus: 'VERIFIED' }, 'COMPANY', { byUserId: 'usr_admin' });
    expect(digio.requestDigioKyc).toHaveBeenCalledWith(expect.objectContaining({ workflowKey: 'PRINT_PARTNER.COMPANY' }));
    expect(repository.reopenDigioForUpgrade).toHaveBeenCalledWith('prt_1', 'COMPANY', expect.anything());
  });
});
