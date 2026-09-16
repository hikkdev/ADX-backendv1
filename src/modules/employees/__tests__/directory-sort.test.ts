import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q113): the directory's server sort.
 *
 * What is pinned: `GET /employees` on the list-contract path takes
 * `?sort=NAME|ROLE|JOINED` with `?dir=asc|desc`; NAME orders by the
 * person's name, ROLE by designation, JOINED by when the record was made;
 * the direction defaults to ascending for the two words and descending for
 * the date — newest first, as the table always drew; anything else is 400.
 */

const { repository, users, auth, identifiers, integrations } = vi.hoisted(() => ({
  repository: {
    findPage: vi.fn(),
    countByActive: vi.fn(),
    findByUserId: vi.fn(),
    findSummaryByUserId: vi.fn(),
    findByExternalHrmsId: vi.fn(),
    findDirectory: vi.fn(),
    sumOpenRoles: vi.fn(),
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
import { employeeOrderBy, listEmployeesQuerySchema } from '../employees.schema';

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

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPage.mockResolvedValue({ items: [], total: 0 });
  repository.countByActive.mockResolvedValue({ ACTIVE: 0, INACTIVE: 0 });
});

describe('the query', () => {
  it('takes the three keys and the two directions, and refuses the rest', () => {
    expect(listEmployeesQuerySchema.parse({ sort: 'NAME' })).toMatchObject({ sort: 'NAME' });
    expect(listEmployeesQuerySchema.parse({ sort: 'ROLE', dir: 'desc' })).toMatchObject({ sort: 'ROLE', dir: 'desc' });
    expect(listEmployeesQuerySchema.parse({ sort: 'JOINED', dir: 'asc' })).toMatchObject({ sort: 'JOINED', dir: 'asc' });
    // G13-B: the region column sorts too.
    expect(listEmployeesQuerySchema.parse({ sort: 'REGION' })).toMatchObject({ sort: 'REGION' });
    expect(listEmployeesQuerySchema.safeParse({ sort: 'DEPARTMENT' }).success).toBe(false);
    expect(listEmployeesQuerySchema.safeParse({ sort: 'NAME', dir: 'up' }).success).toBe(false);
  });

  it('defaults the direction by the key: the words ascend, the date descends', () => {
    expect(employeeOrderBy({ sort: 'NAME' })).toEqual({ sort: 'NAME', dir: 'asc' });
    expect(employeeOrderBy({ sort: 'ROLE' })).toEqual({ sort: 'ROLE', dir: 'asc' });
    expect(employeeOrderBy({ sort: 'REGION' })).toEqual({ sort: 'REGION', dir: 'asc' });
    expect(employeeOrderBy({ sort: 'JOINED' })).toEqual({ sort: 'JOINED', dir: 'desc' });
    expect(employeeOrderBy({})).toEqual({ sort: 'JOINED', dir: 'desc' });
    expect(employeeOrderBy({ sort: 'NAME', dir: 'desc' })).toEqual({ sort: 'NAME', dir: 'desc' });
  });
});

describe('GET /employees?page=', () => {
  it.each([
    ['NAME', undefined, { sort: 'NAME', dir: 'asc' }],
    ['NAME', 'desc', { sort: 'NAME', dir: 'desc' }],
    ['ROLE', undefined, { sort: 'ROLE', dir: 'asc' }],
    ['ROLE', 'desc', { sort: 'ROLE', dir: 'desc' }],
    ['JOINED', undefined, { sort: 'JOINED', dir: 'desc' }],
    ['JOINED', 'asc', { sort: 'JOINED', dir: 'asc' }],
    ['REGION', undefined, { sort: 'REGION', dir: 'asc' }],
    ['REGION', 'desc', { sort: 'REGION', dir: 'desc' }],
  ])('sorts by %s %s', async (sort, dir, expected) => {
    const res = await request(app())
      .get(`/api/v1/employees?page=1&sort=${sort}${dir ? `&dir=${dir}` : ''}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.findPage).toHaveBeenCalledWith({ q: undefined, department: undefined, active: undefined }, 1, 20, expected);
    // The sort never leaks into the chip count's filter.
    expect(repository.countByActive).toHaveBeenCalledWith({ q: undefined, department: undefined, active: undefined });
  });

  it('is a 400 on a key it does not know', async () => {
    const res = await request(app()).get('/api/v1/employees?page=1&sort=SALARY').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('G13-B: the list rows keep region, workMode and employmentType — the row is the Employee record with its user and department joined', async () => {
    repository.findPage.mockResolvedValue({
      items: [
        {
          id: 'emp_1',
          userId: 'usr_1',
          department: null,
          designation: 'Analyst',
          region: 'South',
          workMode: 'HYBRID',
          employmentType: 'FULL_TIME',
          isActive: true,
          user: { id: 'usr_1', name: 'Asha', mobile: null, email: null },
          departmentRecord: { id: 'dep_1', name: 'Ops', code: 'OPS' },
        },
      ],
      total: 1,
    });
    const res = await request(app()).get('/api/v1/employees?page=1&sort=REGION').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({ region: 'South', workMode: 'HYBRID', employmentType: 'FULL_TIME', department: 'Ops' });
  });

  it('sorts the bare-array path the same way', async () => {
    const res = await request(app()).get('/api/v1/employees?sort=ROLE&dir=desc').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.findPage).toHaveBeenCalledWith(expect.objectContaining({}), 1, 20, { sort: 'ROLE', dir: 'desc' });
  });
});

/* ── G13-B: the overview ──────────────────────────────────────────────────── */

describe('GET /employees/overview', () => {
  it('answers the headcount and openPositions = the sum of Department.openRoles; ADMIN only', async () => {
    repository.countByActive.mockResolvedValue({ ACTIVE: 12, INACTIVE: 3 });
    repository.sumOpenRoles.mockResolvedValue(7);
    const res = await request(app()).get('/api/v1/employees/overview').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ headcount: { total: 15, active: 12, inactive: 3 }, openPositions: 7 });
    expect(repository.countByActive).toHaveBeenCalledWith(expect.objectContaining({ active: undefined, q: undefined }));

    const staff = tokenFor(['PUBLISHER'], 'pub_1');
    expect((await request(app()).get('/api/v1/employees/overview').set('Authorization', `Bearer ${staff}`)).status).toBe(403);
  });
});
