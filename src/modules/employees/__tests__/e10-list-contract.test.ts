import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: `GET /employees` on the list contract.
 *
 * What is pinned: with `?page=` in the query the answer is
 * `{ items, total, page, pageSize, counts }` with the chips by the active
 * flag, counted with the `active` facet removed; the `meta` sibling stays a
 * release; without `page` the bare array and its meta are byte for byte
 * what they were. And the directory read can include the inactive, each row
 * saying whether it is.
 */

const { repository, users, auth, identifiers, integrations } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn(),
    countByActive: vi.fn(),
    findByUserId: vi.fn(),
    findSummaryByUserId: vi.fn(),
    findByExternalHrmsId: vi.fn(),
    findDirectory: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  users: { userExists: vi.fn() },
  auth: { createInvite: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn() },
  integrations: { getEffectiveHrmsConfig: vi.fn() },
}));

vi.mock('../prisma-employees.repository', () => ({ prismaEmployeeRepository: repository }));
vi.mock('../../users', () => users);
vi.mock('../../auth', () => auth);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...integrations };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { employeeRouter } from '../employees.routes';
import { listActiveEmployeesForDirectory } from '../employees.service';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/employees', employeeRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');

const record = (over: Record<string, unknown> = {}) => ({
  id: 'emp_1',
  userId: 'usr_1',
  displayId: 'EMP-1209-2601',
  department: 'Ops',
  designation: 'Coordinator',
  isActive: true,
  user: { id: 'usr_1', name: 'Asha', mobile: '+919845012210', email: 'asha@adx.co' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPage.mockResolvedValue({ items: [record()], total: 41 });
  repository.countByActive.mockResolvedValue({ ACTIVE: 38, INACTIVE: 3 });
});

describe('GET /employees', () => {
  it('keeps the bare array and its meta when no page is asked for', async () => {
    const res = await request(app()).get('/api/v1/employees?q=asha').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 41, totalPages: 3 });
    expect(repository.countByActive).not.toHaveBeenCalled();
  });

  it('answers the list contract, chips by the active flag, when ?page= is given — meta still beside it', async () => {
    const res = await request(app()).get('/api/v1/employees?page=2&pageSize=20&active=true&department=Ops').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    // Lot G (Q113): newest joined first when no sort is asked for — what the table always drew.
    expect(repository.findPage).toHaveBeenCalledWith({ q: undefined, department: 'Ops', active: true }, 2, 20, { sort: 'JOINED', dir: 'desc' });
    // The chips are counted with the active facet removed, the rest of the filter kept.
    expect(repository.countByActive).toHaveBeenCalledWith({ q: undefined, department: 'Ops', active: undefined });
    expect(res.body.data).toEqual({
      items: [expect.objectContaining({ id: 'emp_1' })],
      total: 41,
      page: 2,
      pageSize: 20,
      counts: { ACTIVE: 38, INACTIVE: 3 },
    });
    expect(res.body.meta).toEqual({ page: 2, pageSize: 20, total: 41, totalPages: 3 });
  });

  // Q-B (owner's item 8): employee-kyc's console read sends `pageSize=100`
  // without `page` — that is a list request too, not the bare array.
  it('answers the list contract when only ?pageSize= is given, page defaulting to 1', async () => {
    const res = await request(app()).get('/api/v1/employees?pageSize=100').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.findPage).toHaveBeenCalledWith({ q: undefined, department: undefined, active: undefined }, 1, 100, { sort: 'JOINED', dir: 'desc' });
    expect(Array.isArray(res.body.data)).toBe(false);
    expect(res.body.data).toEqual(
      expect.objectContaining({ items: [expect.objectContaining({ id: 'emp_1' })], total: 41, page: 1, pageSize: 100, counts: { ACTIVE: 38, INACTIVE: 3 } }),
    );
    expect(res.body.meta).toEqual({ page: 1, pageSize: 100, total: 41, totalPages: 1 });
  });

  it('with neither page nor pageSize, the bare array is kept for the two readers that exist', async () => {
    const res = await request(app()).get('/api/v1/employees?active=true').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(repository.countByActive).not.toHaveBeenCalled();
  });
});

describe('the directory read', () => {
  it('lists the active by default, each row flagged active', async () => {
    repository.findDirectory.mockResolvedValue([
      { userId: 'usr_1', department: 'Ops', designation: 'Coordinator', isActive: true, user: { name: 'Asha' } },
    ]);
    const people = await listActiveEmployeesForDirectory('as');
    expect(repository.findDirectory).toHaveBeenCalledWith('as', false);
    expect(people).toEqual([{ userId: 'usr_1', name: 'Asha', designation: 'Coordinator', department: 'Ops', active: true }]);
  });

  it('includes the inactive when asked, flagged active:false', async () => {
    repository.findDirectory.mockResolvedValue([
      { userId: 'usr_1', department: 'Ops', designation: 'Coordinator', isActive: true, user: { name: 'Asha' } },
      { userId: 'usr_2', department: 'Ops', designation: 'Former', isActive: false, user: { name: 'Bala' } },
    ]);
    const people = await listActiveEmployeesForDirectory(undefined, { includeInactive: true });
    expect(repository.findDirectory).toHaveBeenCalledWith(undefined, true);
    expect(people.map((p) => [p.userId, p.active])).toEqual([
      ['usr_1', true],
      ['usr_2', false],
    ]);
  });
});
