import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: what `hr` reads through this module's index gains two columns —
 * a department member's `joinedAt` (the Employee row's createdAt: "on
 * record since"; the real joining date is the HR tool's, Q98) and the
 * directory row's `employeeId` beside `userId`.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findDirectory: vi.fn(), findByDepartment: vi.fn() },
}));

vi.mock('../prisma-employees.repository', () => ({ prismaEmployeeRepository: repository }));
vi.mock('../../users', () => ({ userExists: vi.fn() }));
vi.mock('../../auth', () => ({ createInvite: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));

import { listActiveEmployeesForDirectory, listDepartmentMembers } from '../employees.service';

const since = new Date('2026-03-02T04:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listDepartmentMembers — joinedAt', () => {
  it('carries the row createdAt as joinedAt on every member', async () => {
    repository.findByDepartment.mockResolvedValue([
      { id: 'emp_1', userId: 'usr_1', displayId: 'EMP-1', designation: 'Coordinator', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME', isActive: true, createdAt: since, user: { name: 'Asha', email: 'asha@adx.co' } },
    ]);
    const members = await listDepartmentMembers('dep_ops');
    expect(members).toEqual([
      { id: 'emp_1', userId: 'usr_1', displayId: 'EMP-1', name: 'Asha', email: 'asha@adx.co', designation: 'Coordinator', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME', active: true, joinedAt: since },
    ]);
  });
});

describe('listActiveEmployeesForDirectory — employeeId', () => {
  it('carries the Employee row id beside the user id', async () => {
    repository.findDirectory.mockResolvedValue([{ id: 'emp_1', userId: 'usr_1', department: 'Ops', designation: 'Coordinator', isActive: true, user: { name: 'Asha' }, departmentRecord: null }]);
    expect(await listActiveEmployeesForDirectory()).toEqual([{ employeeId: 'emp_1', userId: 'usr_1', name: 'Asha', designation: 'Coordinator', department: 'Ops', active: true }]);
  });
});
