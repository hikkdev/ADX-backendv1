import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q122/Q140) — departments.
 *
 * What is pinned: the list is on the list contract with a member count on
 * every row; the detail carries head, parent, children, regions, open roles
 * and the members with region / work mode / employment type; every write is
 * ADMIN and audited with its target; a name or code taken twice is 409; a
 * parent may not be the department itself or anything under it; a delete
 * is refused while people (or child departments) are still in it; and the
 * boot seed turns the free strings on Employee rows into records once,
 * idempotently, linking the rows — never touching a record that exists.
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
import { ensureDepartments } from '../departments/departments.service';
import { codeFromName } from '../departments/departments.schema';

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
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

const dept = (over: Record<string, unknown> = {}) => ({
  id: 'dep_ops',
  name: 'Operations',
  code: 'OPS',
  description: null,
  headId: 'emp_1',
  parentId: null,
  regions: ['Bengaluru', 'Chennai'],
  openRoles: 2,
  isActive: true,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  parent: null,
  children: [{ id: 'dep_field', name: 'Field', code: 'FIELD', isActive: true }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAll.mockResolvedValue([dept(), dept({ id: 'dep_field', name: 'Field', code: 'FIELD', parentId: 'dep_ops', parent: { id: 'dep_ops', name: 'Operations', code: 'OPS' }, children: [], headId: null })]);
  repository.countByActive.mockResolvedValue({ ACTIVE: 2, INACTIVE: 0 });
  repository.findById.mockImplementation(async (id: string) => (id === 'dep_ops' ? dept() : id === 'dep_field' ? dept({ id: 'dep_field', name: 'Field', code: 'FIELD', parentId: 'dep_ops', parent: { id: 'dep_ops', name: 'Operations', code: 'OPS' }, children: [], headId: null }) : null));
  repository.findByName.mockResolvedValue(null);
  repository.findByCode.mockResolvedValue(null);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ ...dept({ id: 'dep_new', headId: null, children: [], regions: [] }), ...data }));
  repository.update.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ ...dept({ id }), ...data }));
  repository.remove.mockResolvedValue(dept());
  employees.countEmployeesByDepartment.mockResolvedValue({ dep_ops: 3, dep_field: 1 });
  employees.listDepartmentMembers.mockResolvedValue([
    { id: 'emp_1', userId: 'usr_1', displayId: 'EMP-1', name: 'Asha', email: 'asha@adx.co', designation: 'Head of ops', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME', active: true },
  ]);
  employees.findEmployeeCard.mockImplementation(async (id: string) => (id === 'emp_1' ? { id: 'emp_1', userId: 'usr_1', name: 'Asha', designation: 'Head of ops' } : null));
  employees.listUnlinkedDepartmentNames.mockResolvedValue([]);
  employees.linkEmployeesToDepartment.mockResolvedValue(0);
});

describe('GET /hr/departments', () => {
  it('is ADMIN at the router', async () => {
    expect((await request(app()).get('/api/v1/hr/departments').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });

  it('is the list contract with a member count and the head on every row', async () => {
    const res = await request(app()).get('/api/v1/hr/departments?page=1&pageSize=20').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 2, page: 1, pageSize: 20, counts: { ACTIVE: 2, INACTIVE: 0 } });
    expect(res.body.data.items[0]).toMatchObject({ id: 'dep_ops', code: 'OPS', memberCount: 3, head: { id: 'emp_1', name: 'Asha' }, regions: ['Bengaluru', 'Chennai'], openRoles: 2 });
    expect(res.body.data.items[1]).toMatchObject({ id: 'dep_field', memberCount: 1, parent: { id: 'dep_ops', name: 'Operations' }, head: null });
    expect(repository.findAll).toHaveBeenCalledWith({ q: undefined, status: undefined }, 'name');
  });

  it('sorts by members when asked and passes the chips filter through', async () => {
    const res = await request(app()).get('/api/v1/hr/departments?sort=members&status=ACTIVE&q=ops').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['dep_ops', 'dep_field']);
    expect(repository.findAll).toHaveBeenCalledWith({ q: 'ops', status: ['ACTIVE'] }, 'name');
    expect((await request(app()).get('/api/v1/hr/departments?status=GONE').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
  });
});

describe('GET /hr/departments/:id', () => {
  it('carries head, parent, children with counts, regions, open roles and the members with their work fields', async () => {
    const res = await request(app()).get('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'dep_ops',
      head: { id: 'emp_1', userId: 'usr_1', name: 'Asha' },
      parent: null,
      children: [{ id: 'dep_field', name: 'Field', memberCount: 1 }],
      regions: ['Bengaluru', 'Chennai'],
      openRoles: 2,
      memberCount: 3,
    });
    expect(res.body.data.members[0]).toMatchObject({ userId: 'usr_1', region: 'Bengaluru', workMode: 'HYBRID', employmentType: 'FULL_TIME', active: true });
    expect(employees.listDepartmentMembers).toHaveBeenCalledWith('dep_ops');
    expect((await request(app()).get('/api/v1/hr/departments/dep_x').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
  });
});

describe('POST /hr/departments', () => {
  it('creates one with a code derived from the name, audited with its target', async () => {
    const res = await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Field operations', regions: [' Chennai ', 'Chennai', 'Kochi'], headId: 'emp_1' });
    expect(res.status).toBe(201);
    expect(repository.create).toHaveBeenCalledWith({
      name: 'Field operations',
      code: 'FIELD-OPERATIONS',
      description: null,
      headId: 'emp_1',
      parentId: null,
      regions: ['Chennai', 'Kochi'],
      openRoles: 0,
      isActive: true,
    });
    expect(res.body.data).toMatchObject({ code: 'FIELD-OPERATIONS', memberCount: 0, head: { id: 'emp_1' } });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'DEPARTMENT_CREATED', expect.objectContaining({ module: 'hr', targetType: 'Department', targetId: 'dep_new' }));
  });

  it('refuses a name or code already taken, a head who is not an employee, and a parent that does not exist', async () => {
    repository.findByName.mockResolvedValue(dept());
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'operations' })).status).toBe(409);
    repository.findByName.mockResolvedValue(null);
    repository.findByCode.mockResolvedValue(dept());
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Ops two', code: 'ops' })).status).toBe(409);
    repository.findByCode.mockResolvedValue(null);
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Ops two', headId: 'emp_ghost' })).status).toBe(404);
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Ops two', parentId: 'dep_ghost' })).status).toBe(404);
    expect((await request(app()).post('/api/v1/hr/departments').set('Authorization', `Bearer ${admin}`).send({ name: 'Ops two', code: 'bad code!' })).status).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /hr/departments/:id', () => {
  it('patches and audits a diff over the record fields', async () => {
    const res = await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({ openRoles: 5, regions: ['Bengaluru'] });
    expect(res.status).toBe(200);
    expect(repository.update).toHaveBeenCalledWith('dep_ops', { openRoles: 5, regions: ['Bengaluru'] });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'DEPARTMENT_UPDATED',
      expect.objectContaining({ targetType: 'Department', targetId: 'dep_ops', diff: expect.any(Object) }),
    );
    expect((await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({})).status).toBe(400);
  });

  it('refuses a parent that is the department itself or one of its descendants', async () => {
    const self = await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({ parentId: 'dep_ops' });
    expect(self.status).toBe(400);
    // dep_field sits under dep_ops; making it dep_ops' parent would close a ring.
    const ring = await request(app()).patch('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`).send({ parentId: 'dep_field' });
    expect(ring.status).toBe(400);
    expect(repository.update).not.toHaveBeenCalled();
    // The other way round is fine.
    const ok = await request(app()).patch('/api/v1/hr/departments/dep_field').set('Authorization', `Bearer ${admin}`).send({ parentId: 'dep_ops' });
    expect(ok.status).toBe(200);
  });
});

describe('DELETE /hr/departments/:id', () => {
  it('is refused while members exist, and while children exist; otherwise deletes and audits', async () => {
    const withMembers = await request(app()).delete('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`);
    expect(withMembers.status).toBe(409);
    expect(withMembers.body.error.details).toMatchObject({ reason: 'DEPARTMENT_HAS_MEMBERS', members: 3 });

    employees.countEmployeesByDepartment.mockResolvedValue({});
    const withChildren = await request(app()).delete('/api/v1/hr/departments/dep_ops').set('Authorization', `Bearer ${admin}`);
    expect(withChildren.status).toBe(409);
    expect(withChildren.body.error.details).toMatchObject({ reason: 'DEPARTMENT_HAS_CHILDREN' });
    expect(repository.remove).not.toHaveBeenCalled();

    const gone = await request(app()).delete('/api/v1/hr/departments/dep_field').set('Authorization', `Bearer ${admin}`);
    expect(gone.status).toBe(200);
    expect(repository.remove).toHaveBeenCalledWith('dep_field');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'DEPARTMENT_DELETED', expect.objectContaining({ targetType: 'Department', targetId: 'dep_field' }));
  });
});

describe('ensureDepartments()', () => {
  it('turns each free string into a record once and links the rows; an existing record (any case) is reused, never rewritten', async () => {
    employees.listUnlinkedDepartmentNames.mockResolvedValue(['Sales', 'operations']);
    repository.findByName.mockImplementation(async (name: string) => (name.toLowerCase() === 'operations' ? dept() : null));
    employees.linkEmployeesToDepartment.mockImplementation(async (name: string) => (name === 'Sales' ? 4 : 2));

    const result = await ensureDepartments();
    expect(result).toEqual({ created: 1, linked: 6 });
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sales', code: 'SALES', isActive: true }));
    expect(repository.update).not.toHaveBeenCalled();
    expect(employees.linkEmployeesToDepartment).toHaveBeenCalledWith('Sales', 'dep_new');
    expect(employees.linkEmployeesToDepartment).toHaveBeenCalledWith('operations', 'dep_ops');
  });

  it('is idempotent: nothing unlinked, nothing written', async () => {
    expect(await ensureDepartments()).toEqual({ created: 0, linked: 0 });
    expect(repository.create).not.toHaveBeenCalled();
    expect(employees.linkEmployeesToDepartment).not.toHaveBeenCalled();
  });

  it('derives a badge-safe code from a name', () => {
    expect(codeFromName('Field operations')).toBe('FIELD-OPERATIONS');
    expect(codeFromName('  R&D / Labs ')).toBe('R-D-LABS');
    expect(codeFromName('Customer success and support')).toBe('CUSTOMER-SUCCESS');
    expect(codeFromName('---')).toBe('DEPT');
  });
});
