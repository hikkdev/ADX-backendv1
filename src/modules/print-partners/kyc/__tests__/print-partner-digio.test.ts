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
  repository: { upsertDigio: vi.fn<AnyFn>(), findByPartnerId: vi.fn<AnyFn>(), findByDigioRequestId: vi.fn<AnyFn>(), applyDigioWebhook: vi.fn<AnyFn>() },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
  notifications: { createNotification: vi.fn<AnyFn>(async () => ({ id: 'ntf_1' })), notify: vi.fn<AnyFn>(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-decision', deliveries: [] })) },
  audit: { logActivity: vi.fn<AnyFn>(async () => undefined) },
}));

vi.mock('../prisma-print-partner-kyc.repository', () => ({ prismaPrintPartnerKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../../shared/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { DIGIO_REFERENCE_PREFIX, handlePrintPartnerDigioWebhook, initiatePrintPartnerDigioKyc, printPartnerDigioStatus, restartPrintPartnerDigioKyc } from '../print-partner-digio.service';

const NOW = new Date('2026-09-14T09:00:00.000Z');
const partner = { id: 'prt_1', name: 'Sharma Prints', email: 'shop@example.in', mobile: '+919999999999' };
const slice = { id: 'prt_1', displayId: 'PRT-1409-2601', name: 'Sharma Prints', mobile: '+919999999999', email: 'shop@example.in', userId: 'usr_prt', city: 'Pune', isActive: true, kycStatus: 'PENDING' };
const row = (over: Record<string, unknown> = {}) => ({ id: 'ppk_1', printPartnerId: 'prt_1', status: 'PENDING', method: 'DIGIO', digioRequestId: 'dg_1', digioStatus: 'pending', submittedAt: null, digioVerifiedAt: null, printPartner: slice, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_1?token=tok', mock: false });
  repository.upsertDigio.mockImplementation(async (_id: string, fields: Record<string, unknown>) => row(fields));
  repository.applyDigioWebhook.mockImplementation(async (_id: string, update: Record<string, unknown>) => row(update));
});

describe('initiate', () => {
  it('from the partner\'s phone: the shared client under an adx-pp- reference, the row DIGIO/pending with submittedAt', async () => {
    const session = await initiatePrintPartnerDigioKyc(partner, { onBehalf: false }, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith({ referenceId: `${DIGIO_REFERENCE_PREFIX}prt_1-${NOW.getTime()}`, customerName: 'Sharma Prints', customerEmail: 'shop@example.in', customerMobile: '+919999999999' });
    expect(repository.upsertDigio).toHaveBeenCalledWith('prt_1', { method: 'DIGIO', digioRequestId: 'dg_1', digioReferenceId: expect.stringMatching(/^adx-pp-prt_1-/), digioStatus: 'pending', submittedAt: NOW });
    expect(session).toEqual({ kycId: 'dg_1', accessToken: 'tok', validTill: '2026-09-15T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_1?token=tok' });
  });

  it('on the desk\'s behalf: the same session, submittedAt left for the webhook (the queue\'s "requested" facet)', async () => {
    await initiatePrintPartnerDigioKyc(partner, { onBehalf: true }, NOW);
    expect(repository.upsertDigio).toHaveBeenCalledWith('prt_1', { method: 'DIGIO', digioRequestId: 'dg_1', digioReferenceId: expect.any(String), digioStatus: 'pending' });
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
});
