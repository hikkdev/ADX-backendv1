import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1 on the HR reads and writes:
 *
 *   GET /hr/departments/:id   every member carries `joinedAt` — the
 *                             Employee row's createdAt, "on record since";
 *                             the real joining date is the HR tool's (Q98);
 *   GET /hr/people            every staff row carries `employeeId` beside
 *                             `userId` (an agent row has none);
 *   POST/PATCH /hr/departments take `headUserId` beside `headId` — the
 *                             login, resolved to the employee record, which
 *                             is what the row stores; both at once is a 400.
 */

const { repository, employees, agents, audit } = vi.hoisted(() => ({
  repository: {
    findAll: vi.fn(),
    countByActive: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    findByCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  employees: {
    listActiveEmployeesForDirectory: vi.fn(),
    findEmployeeByUserId: vi.fn(),
    listDepartmentMembers: vi.fn(),
    countEmployeesByDepartment: vi.fn(),
    findEmployeeCard: vi.fn(),
    listUnlinkedDepartmentNames: vi.fn(),
    linkEmployeesToDepartment: vi.fn(),
  },
  agents: { listActiveAgentsForDirectory: vi.fn(), findAgentProfile: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../departments/prisma-departments.repository', () => ({ prismaDepartmentsRepository: repository }));
vi.mock('../prisma-hr.repository', () => ({ prismaHrRepository: {} }));
vi.mock('../../employees', () => employees);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { hrRouter } from '../hr.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/hr', hrRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');
const since = new Date('2026-03-02T04:30:00.000Z');

const dept = (over: Record<string, unknown> = {}) => ({
  id: 'dep_ops',
  name: 'Operations',
  code: 'OPS',
  description: null,
  headId: null,
  parentId: null,
  regions: [],
  openRoles: 0,
  isActive: true,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  parent: null,
  children: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockImplementation(async (id: string) => (id === 'dep_ops' ? dept() : null));
  repository.findByName.mockResolvedValue(null);
  repository.findByCode.mockResolvedValue(null);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ ...dept({ id: 'dep_new' }), ...data }));
  repository.update.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ ...dept({ id }), ...data }));
  employees.countEmployeesByDepartment.mockResolvedValue({ dep_ops: 1 });
  employees.listDepartmentMembers.mockResolvedValue([
    { id: 'emp_1', userId: 'usr_1', displayId: 'EMP-1', name: 'Asha', email: 'asha@adx.co', designation: 'Head of ops', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME', active: true, joinedAt: since },
  ]);
  employees.findEmployeeCard.mockImplementation(async (id: string) => (id === 'emp_1' ? { id: 'emp_1', userId: 'usr_1', name: 'Asha', designation: 'Head of ops' } : null));
  employees.findEmployeeByUserId.mockImplementation(async (userId: string) => (userId === 'usr_1' ? { id: 'emp_1', userId: 'usr_1', isActive: true } : null));
  employees.listActiveEmployeesForDirectory.mockResolvedValue([{ employeeId: 'emp_1', userId: 'usr_1', name: 'Asha', designation: 'Head of ops', department: 'Operations', active: true }]);
  agents.listActiveAgentsForDirectory.mockResolvedValue([{ userId: 'usr_agt', name: 'Ravi', tier: 'SILVER', agentProfileId: 'agt_1', active: true }]);
});

describe('GET /hr/departments/:id — joinedAt on every member', () => {
  it('prints the row date the employees read carries', async () => {
    const res = await request(app()).get('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.members[0]).toMatchObject({ id: 'emp_1', userId: 'usr_1', joinedAt: since.toISOString() });
  });
});

describe('GET /hr/people — employeeId beside userId', () => {
  it('carries the Employee row id on staff rows and nothing of the kind on agents', async () => {
    const res = await request(app()).get('/api/v1/hr/people').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const staff = res.body.data.find((p: { kind: string }) => p.kind === 'STAFF');
    const agent = res.body.data.find((p: { kind: string }) => p.kind === 'AGENT');
    expect(staff).toMatchObject({ userId: 'usr_1', employeeId: 'emp_1', kind: 'STAFF' });
    expect(agent).toMatchObject({ userId: 'usr_agt', agentProfileId: 'agt_1', kind: 'AGENT' });
    expect(agent.employeeId).toBeUndefined();
  });
});

describe('headUserId on the department writes', () => {
  it('POST resolves the login to the employee record and stores that', async () => {
    const res = await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Field operations', headUserId: 'usr_1' });
    expect(res.status).toBe(201);
    expect(employees.findEmployeeByUserId).toHaveBeenCalledWith('usr_1');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ headId: 'emp_1' }));
    expect(res.body.data).toMatchObject({ headId: 'emp_1', head: { id: 'emp_1', userId: 'usr_1', name: 'Asha' } });
  });

  it('PATCH takes it too, and null clears the head', async () => {
    const res = await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({ headUserId: 'usr_1' });
    expect(res.status).toBe(200);
    expect(repository.update).toHaveBeenCalledWith('dep_ops', { headId: 'emp_1' });
    const cleared = await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({ headUserId: null });
    expect(cleared.status).toBe(200);
    expect(repository.update).toHaveBeenLastCalledWith('dep_ops', { headId: null });
  });

  it('404s a login with no employee record, and 400s when both headId and headUserId are sent', async () => {
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Ops two', headUserId: 'usr_ghost' })).status).toBe(404);
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Ops two', headId: 'emp_1', headUserId: 'usr_1' })).status).toBe(400);
    expect((await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({ headId: 'emp_1', headUserId: 'usr_1' })).status).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });
});
