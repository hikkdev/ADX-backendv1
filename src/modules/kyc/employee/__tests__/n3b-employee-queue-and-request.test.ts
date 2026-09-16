import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B — employees in the KYC queue from the moment the row exists, and the
 * one-click Digio request, the agent's twin for staff.
 *
 * What is pinned: `GET /employee-kyc` lists every Employee with its state
 * and `meta.counts` per state (`status=` the alias of `state=`);
 * `POST /employee-kyc/:employeeId/request` defaults to DIGIO, opens a
 * session on the employee's behalf with the `adx-emp-` reference, stamps
 * the request, tells the employee (KYC_REQUESTED), audits
 * EMPLOYEE_KYC_REQUESTED, is 404 for no employee and 409 once verified;
 * Digio's answer lands on the employee's record and tells them.
 */

type AnyFn = (...args: any[]) => any;

const { repository, digio, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn<AnyFn>(),
    countByState: vi.fn<AnyFn>(),
    findByEmployeeId: vi.fn<AnyFn>(),
    findEmployeeContact: vi.fn<AnyFn>(),
    record: vi.fn<AnyFn>(),
    review: vi.fn<AnyFn>(),
    requestKyc: vi.fn<AnyFn>(),
    upsertDigio: vi.fn<AnyFn>(),
    findByDigioRequestId: vi.fn<AnyFn>(),
    applyDigioWebhook: vi.fn<AnyFn>(),
  },
  digio: { requestDigioKyc: vi.fn<AnyFn>() },
  notifications: { notify: vi.fn<AnyFn>(async () => ({ notificationId: 'ntf_1', templateKey: 'kyc-requested', deliveries: [] })), createNotification: vi.fn<AnyFn>() },
  audit: { logActivity: vi.fn<AnyFn>(), auditDiff: vi.fn<AnyFn>(() => ({})) },
}));

vi.mock('../prisma-employee-kyc.repository', () => ({ prismaEmployeeKycRepository: repository }));
vi.mock('../../../../shared/integrations/digio-client', () => digio);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })), getFlow: vi.fn(async () => null) }));

import { EMPLOYEE_KYC_DEEP_LINK, listEmployeeKycs, requestEmployeeKyc } from '../employee-kyc.service';
import { handleEmployeeDigioWebhook } from '../employee-digio.service';
import { listEmployeeKycsHandler } from '../employee-kyc.controller';

const NOW = new Date('2026-09-14T22:00:00.000Z');
const employee = { id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1209-2601', user: { name: 'Priya', email: 'priya@adx.in', mobile: '+919812340002' } };
const slice = { id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1209-2601', department: 'Ops', designation: 'Analyst', createdAt: NOW, user: { name: 'Priya', mobile: '+919812340002', email: 'priya@adx.in' } };
const counts = { AWAITING_DOCUMENTS: 2, REQUESTED: 0, PENDING: 1, NEEDS_INFO: 0, REJECTED: 0, VERIFIED: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  repository.countByState.mockResolvedValue(counts);
  repository.findEmployeeContact.mockImplementation(async (id: string) => (id === 'emp_1' ? employee : null));
  repository.findByEmployeeId.mockResolvedValue(null);
  repository.requestKyc.mockImplementation(async (employeeId: string, stamp: Record<string, unknown>) => ({ id: 'ekyc_1', employeeId, status: 'PENDING', submittedAt: null, requestedAt: stamp['at'], requestedById: stamp['requestedById'], requestedChannel: stamp['requestedChannel'], employee: slice }));
  repository.upsertDigio.mockResolvedValue({ id: 'ekyc_1' });
  digio.requestDigioKyc.mockResolvedValue({ kycId: 'dg_emp_1', accessToken: 'tok', validTill: '2026-09-16T00:00:00.000Z', sdkUrl: 'https://app.digio.in/#dg_emp_1?token=tok', mock: false });
});

describe('GET /employee-kyc — every employee', () => {
  it('answers the rows with their state and the counts per state in meta; `state=` the facet, `status=` its alias', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        { id: 'emp_new', employeeId: 'emp_new', kycId: null, state: 'AWAITING_DOCUMENTS', status: null, employee: slice },
        { id: 'ekyc_1', employeeId: 'emp_1', kycId: 'ekyc_1', state: 'PENDING', status: 'PENDING', submittedAt: NOW, employee: slice },
      ],
      total: 2,
    });
    const { items, meta } = await listEmployeeKycs({}, 1, 20);
    expect(items.map((row) => row.state)).toEqual(['AWAITING_DOCUMENTS', 'PENDING']);
    expect(meta).toEqual({ page: 1, pageSize: 20, total: 2, totalPages: 1, counts: { ...counts, awaitingDocuments: 2 } });

    const res = { json: vi.fn() } as never;
    await listEmployeeKycsHandler({ query: { state: 'requested' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({ state: 'REQUESTED' }, 1, 20);
    await listEmployeeKycsHandler({ query: { status: 'PENDING', q: 'Priya' }, user: { sub: 'usr_admin' } } as never, res);
    expect(repository.findPage).toHaveBeenLastCalledWith({ status: 'PENDING', q: 'Priya' }, 1, 20);
  });
});

describe('POST /employee-kyc/:employeeId/request — the one click', () => {
  it('DIGIO: opens the session with the employee’s own contact and the adx-emp- reference, stamps, tells, audits EMPLOYEE_KYC_REQUESTED', async () => {
    const result = await requestEmployeeKyc('emp_1', { channel: 'DIGIO' }, 'usr_hr', undefined, NOW);
    expect(digio.requestDigioKyc).toHaveBeenCalledWith({ referenceId: `adx-emp-emp_1-${NOW.getTime()}`, customerName: 'Priya', customerEmail: 'priya@adx.in', customerMobile: '+919812340002' });
    expect(repository.upsertDigio).toHaveBeenCalledWith('emp_1', expect.objectContaining({ method: 'DIGIO', digioRequestId: 'dg_emp_1', digioStatus: 'pending' }));
    expect(repository.requestKyc).toHaveBeenCalledWith('emp_1', { requestedById: 'usr_hr', requestedChannel: 'DIGIO', at: NOW });
    expect(notifications.notify).toHaveBeenCalledWith('KYC_REQUESTED', 'usr_emp', { partyName: 'Priya', channel: 'Digio', note: '', deepLink: EMPLOYEE_KYC_DEEP_LINK }, expect.objectContaining({ inApp: expect.objectContaining({ relatedId: 'ekyc_1' }) }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_hr', 'EMPLOYEE_KYC_REQUESTED', expect.objectContaining({ targetType: 'EmployeeKyc', targetId: 'ekyc_1', module: 'kyc', metadata: expect.objectContaining({ employeeId: 'emp_1', channel: 'DIGIO', digioKycId: 'dg_emp_1' }) }));
    expect(result).toMatchObject({ digio: { kycId: 'dg_emp_1' }, notified: true });
  });

  it('404 for no employee; 409 once verified — nothing sent', async () => {
    await expect(requestEmployeeKyc('emp_x', { channel: 'DIGIO' }, 'usr_hr')).rejects.toMatchObject({ statusCode: 404 });
    repository.findByEmployeeId.mockResolvedValue({ id: 'ekyc_1', status: 'VERIFIED' });
    await expect(requestEmployeeKyc('emp_1', { channel: 'DIGIO' }, 'usr_hr')).rejects.toMatchObject({ statusCode: 409, code: 'KYC_ALREADY_VERIFIED' });
    expect(digio.requestDigioKyc).not.toHaveBeenCalled();
    expect(repository.requestKyc).not.toHaveBeenCalled();
  });
});

describe('Digio’s answer on the employee’s record', () => {
  it('claims the employee’s request id, applies the decision with a submittedAt, tells the employee; a stranger’s id is left alone', async () => {
    repository.findByDigioRequestId.mockResolvedValue({ id: 'ekyc_1', employeeId: 'emp_1', submittedAt: null, employee: slice });
    repository.applyDigioWebhook.mockResolvedValue({ id: 'ekyc_1' });
    expect(await handleEmployeeDigioWebhook({ id: 'dg_emp_1', customer_identifier: 'x', status: 'approved' }, NOW)).toBe(true);
    expect(repository.applyDigioWebhook).toHaveBeenCalledWith('ekyc_1', expect.objectContaining({ status: 'VERIFIED', digioVerifiedAt: NOW, reviewedAt: NOW, submittedAt: NOW }));
    expect(notifications.notify).toHaveBeenCalledWith('KYC_DECISION', 'usr_emp', expect.objectContaining({ partyName: 'Priya', decision: 'verified' }), expect.anything());
    repository.findByDigioRequestId.mockResolvedValue(null);
    expect(await handleEmployeeDigioWebhook({ id: 'dg_other', customer_identifier: 'x', status: 'approved' })).toBe(false);
  });
});
