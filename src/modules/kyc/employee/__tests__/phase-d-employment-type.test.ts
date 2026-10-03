import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase D follow-up (1 Oct 2026): the employee KYC queue rows and the case
 * read carry `employee.employmentType` — the console joined it from the HR
 * roster because the repository's employee slice left it out, and the
 * Digio card needs it to say which workflow (full time, or intern and
 * contract) the employee is on.
 *
 * Pinned: the Prisma select names the column, and the queue and the case
 * read pass it through untouched — null when HR has not set it.
 */

const { repository, audit, notifications } = vi.hoisted(() => ({
  repository: { findPage: vi.fn(), countByState: vi.fn(), findByEmployeeId: vi.fn(), findEmployeeContact: vi.fn(), record: vi.fn(), review: vi.fn(), requestKyc: vi.fn(), upsertDigio: vi.fn(), markProviderFailed: vi.fn(), findByDigioRequestId: vi.fn(), applyDigioWebhook: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn() },
  notifications: { notify: vi.fn(), createNotification: vi.fn() },
}));

vi.mock('../prisma-employee-kyc.repository', () => ({ prismaEmployeeKycRepository: repository }));
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../case-read', () => ({ kycCaseExtras: vi.fn(async () => ({ ageHours: 1, breached: false })) }));

import type { EmployeeSlice } from '../employee-kyc.repository';
import { getEmployeeKyc, listEmployeeKycs } from '../employee-kyc.service';

const NOW = new Date('2026-10-01T10:00:00Z');
const slice: EmployeeSlice = { id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1209-2601', department: 'Ops', designation: 'Analyst', employmentType: 'INTERN', createdAt: NOW, user: { name: 'Priya', mobile: '+919812340002', email: 'priya@adx.in' } };

beforeEach(() => {
  vi.clearAllMocks();
  repository.countByState.mockResolvedValue({ AWAITING_DOCUMENTS: 0, REQUESTED: 0, PENDING: 1, NEEDS_INFO: 0, VERIFIED: 0, REJECTED: 0 });
});

describe('employmentType on the employee KYC reads', () => {
  it('is in the Prisma select of the employee slice', () => {
    const source = fs.readFileSync(path.join(__dirname, '../prisma-employee-kyc.repository.ts'), 'utf8');
    const select = source.slice(source.indexOf('const employeeSelect'), source.indexOf('as const;'));
    expect(select).toContain('employmentType: true');
  });

  it('rides the queue rows and the case read untouched — null when HR has not set it', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        { id: 'ekyc_1', employeeId: 'emp_1', kycId: 'ekyc_1', state: 'PENDING', status: 'PENDING', submittedAt: NOW, employee: slice },
        { id: 'emp_2', employeeId: 'emp_2', kycId: null, state: 'AWAITING_DOCUMENTS', status: null, employee: { ...slice, id: 'emp_2', employmentType: null } },
      ],
      total: 2,
    });
    const { items } = await listEmployeeKycs({}, 1, 20);
    expect(items.map((row) => row.employee.employmentType)).toEqual(['INTERN', null]);

    repository.findByEmployeeId.mockResolvedValue({ id: 'ekyc_1', employeeId: 'emp_1', status: 'PENDING', submittedAt: NOW, employee: slice });
    const kycCase = await getEmployeeKyc('emp_1', NOW);
    expect(kycCase.employee.employmentType).toBe('INTERN');
  });
});
