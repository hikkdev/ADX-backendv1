import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D — employee KYC, the agent record's twin.
 *
 * What is pinned: the employee reads their own record through the port's
 * answer for their user (404 with no employee row, null before a recording);
 * recording is on the employee's behalf, an upsert back to PENDING that
 * remembers the recorder and is audited; a review stamps who and is audited
 * with a diff; a rejection must say why; the port unregistered answers
 * "not found" rather than failing.
 */

const { repository, audit, appConfig } = vi.hoisted(() => ({
  repository: { findPage: vi.fn(), countByState: vi.fn(async () => ({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 0, NEEDS_INFO: 0, REJECTED: 0, VERIFIED: 0 })), findByEmployeeId: vi.fn(), record: vi.fn(), review: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({ status: { before: 'PENDING', after: 'VERIFIED' } })) },
  appConfig: { getPlatformSettings: vi.fn(async () => ({ kyc: { reviewSlaHours: 48 } })), getFlow: vi.fn() },
}));

vi.mock('../prisma-employee-kyc.repository', () => ({ prismaEmployeeKycRepository: repository }));
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../app-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app-config')>();
  return { ...actual, ...appConfig };
});

import { getEmployeeIntakeLadder, getEmployeeKyc, getMyEmployeeKyc, listEmployeeKycs, recordEmployeeKyc, reviewEmployeeKyc } from '../employee-kyc.service';
import { registerEmployeeLookupPort } from '../employee-lookup.port';

const row = { id: 'ekyc_1', employeeId: 'emp_1', status: 'PENDING', recordedById: 'usr_hr', employee: { id: 'emp_1', user: { name: 'Ravi' } } };

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.getFlow.mockResolvedValue(null);
  registerEmployeeLookupPort({
    findByUserId: async (userId) => (userId === 'usr_emp' ? { id: 'emp_1' } : null),
    exists: async (employeeId) => employeeId === 'emp_1',
  });
  repository.findByEmployeeId.mockResolvedValue(row);
  repository.record.mockImplementation(async (employeeId: string, data: object, recordedById: string) => ({ ...row, ...data, employeeId, recordedById }));
  repository.review.mockImplementation(async (_id: string, status: string, rejectionReason: string | null, reviewedById: string) => ({ ...row, status, rejectionReason, reviewedById }));
  repository.findPage.mockResolvedValue({ items: [row], total: 1 });
});

describe('the employee reading their own record', () => {
  it('answers through the port, 404 with no employee row, null before a recording', async () => {
    await expect(getMyEmployeeKyc('usr_emp')).resolves.toMatchObject({ id: 'ekyc_1' });
    await expect(getMyEmployeeKyc('usr_nobody')).rejects.toMatchObject({ statusCode: 404 });
    repository.findByEmployeeId.mockResolvedValue(null);
    await expect(getMyEmployeeKyc('usr_emp')).resolves.toBeNull();
  });
});

describe('recording on the employee behalf', () => {
  it('upserts with the recorder and audits; an unknown employee is 404', async () => {
    const recorded = await recordEmployeeKyc('emp_1', { govIdType: 'AADHAAR', panNumber: 'ABCDE1234F' }, 'usr_hr');
    expect(repository.record).toHaveBeenCalledWith('emp_1', { govIdType: 'AADHAAR', panNumber: 'ABCDE1234F' }, 'usr_hr');
    expect(recorded).toMatchObject({ recordedById: 'usr_hr' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_hr', 'EMPLOYEE_KYC_RECORDED', expect.objectContaining({ targetType: 'EmployeeKyc', targetId: 'ekyc_1' }));
    await expect(recordEmployeeKyc('emp_x', {}, 'usr_hr')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the review', () => {
  it('stamps the reviewer, audits with a diff, and a rejection must say why', async () => {
    await expect(reviewEmployeeKyc('emp_1', 'VERIFIED', undefined, 'usr_admin')).resolves.toMatchObject({ status: 'VERIFIED', reviewedById: 'usr_admin' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'EMPLOYEE_KYC_REVIEWED', expect.objectContaining({ diff: expect.any(Object) }));
    await expect(reviewEmployeeKyc('emp_1', 'REJECTED', '  ', 'usr_admin')).rejects.toMatchObject({ statusCode: 400 });
    await expect(reviewEmployeeKyc('emp_1', 'REJECTED', 'Expired ID', 'usr_admin')).resolves.toMatchObject({ status: 'REJECTED', rejectionReason: 'Expired ID' });
  });

  it('pages the queue in arrival order with the meta', async () => {
    const { items, meta } = await listEmployeeKycs({ status: 'PENDING' }, 1, 20);
    expect(repository.findPage).toHaveBeenCalledWith({ status: 'PENDING' }, 1, 20);
    expect(items).toHaveLength(1);
    expect(meta).toMatchObject({ page: 1, pageSize: 20, total: 1 });
  });
});

describe('the port unregistered', () => {
  it('answers not found rather than failing', async () => {
    registerEmployeeLookupPort({ findByUserId: async () => null, exists: async () => false });
    await expect(getMyEmployeeKyc('usr_emp')).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordEmployeeKyc('emp_1', {}, 'usr_hr')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('E7-3: the desk case read', () => {
  it('carries the age against the SLA and the people by name — unregistered port, names null', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    repository.findByEmployeeId.mockResolvedValue({ ...row, submittedAt: new Date(now.getTime() - 2 * 3600_000) });
    await expect(getEmployeeKyc('emp_1', now)).resolves.toMatchObject({
      id: 'ekyc_1',
      ageHours: 2,
      slaBreached: false,
      slaHours: 48,
      recordedBy: { id: 'usr_hr', name: null },
      reviewedBy: null,
      assignedTo: null,
    });
  });
});

describe('the intake ladder (Lot G, Q126/Q141)', () => {
  it('is the code ladder while flows.employee-intake is absent, and the case read lays the record over it', async () => {
    const ladder = await getEmployeeIntakeLadder();
    expect(appConfig.getFlow).toHaveBeenCalledWith('employee-intake');
    expect(ladder.source).toBe('code');
    expect(ladder.steps.map((s) => s.key)).toEqual(['IDENTITY', 'PAN', 'ADDRESS', 'SELFIE', 'BANK']);

    repository.findByEmployeeId.mockResolvedValue({ ...row, govIdFrontUrl: 'https://f/x.png', govIdBackUrl: 'https://f/y.png', panNumber: 'ABCDE1234F' });
    const kyc = await getEmployeeKyc('emp_1');
    expect(kyc.intake).toMatchObject({ version: 1, source: 'code', met: 3, total: 8 });
    expect(kyc.intake.steps[0]).toMatchObject({ key: 'IDENTITY', complete: true });
    expect(kyc.intake.steps[1]).toMatchObject({ key: 'PAN', complete: false });
    expect(kyc.intake.steps[1]!.proofs.map((p) => [p.key, p.met])).toEqual([['panNumber', true], ['panFrontUrl', false], ['panSignatureUrl', false]]);
  });

  it('serves a stored ladder that fits the vocabulary, and the code ladder when it does not', async () => {
    appConfig.getFlow.mockResolvedValue({
      version: 2,
      steps: [
        { key: 'id', number: 1, title: 'ID', proofs: [{ key: 'govIdFrontUrl', label: 'ID' }] },
        { key: 'pan', number: 2, title: 'PAN', proofs: [{ key: 'panFrontUrl', label: 'PAN' }] },
        { key: 'addr', number: 3, title: 'Address', proofs: [{ key: 'addressProofUrl', label: 'Address' }] },
        { key: 'face', number: 4, title: 'Selfie', proofs: [{ key: 'selfieUrl', label: 'Selfie' }] },
      ],
    });
    let ladder = await getEmployeeIntakeLadder();
    expect(ladder).toMatchObject({ source: 'config', version: 2 });
    expect(ladder.steps).toHaveLength(4);

    appConfig.getFlow.mockResolvedValue({ version: 3, steps: [{ key: 'id', number: 1, title: 'ID', proofs: [] }] });
    ladder = await getEmployeeIntakeLadder();
    expect(ladder.source).toBe('code');
  });
});
