import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E (Q98/Q99) — holidays and the people registry.
 *
 * What is pinned: holidays are the one HR record kept in-house, ADMIN-only
 * and audited on every write, with a national day (no region) refused twice;
 * the boot seed is idempotent — it never rewrites a name ops changed and never
 * inserts a day that is already there; and the people registry is the union
 * of active staff and ACTIVE agents, each row saying which it is, read
 * through the two modules' indexes and never their tables.
 */

const { repository, employees, agents, audit } = vi.hoisted(() => ({
  repository: {
    findHolidaysInYear: vi.fn(),
    findHolidaysInRange: vi.fn(),
    findHolidayById: vi.fn(),
    findHolidayOn: vi.fn(),
    createHoliday: vi.fn(),
    updateHoliday: vi.fn(),
    removeHoliday: vi.fn(),
  },
  employees: { listActiveEmployeesForDirectory: vi.fn(), findEmployeeByUserId: vi.fn() },
  agents: { listActiveAgentsForDirectory: vi.fn(), findAgentProfile: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-hr.repository', () => ({ prismaHrRepository: repository }));
vi.mock('../../employees', () => employees);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { hrRouter } from '../hr.routes';
import { HOLIDAYS_2026 } from '../holidays-2026';
import { ensureHolidays, holidaysInRange, toHolidayView } from '../holidays.service';
import { findPerson, listPeople } from '../people.service';

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
const agentToken = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

const holiday = (over: Record<string, unknown> = {}) => ({
  id: 'hol_1',
  date: new Date('2026-10-02T00:00:00.000Z'),
  name: 'Gandhi Jayanti',
  region: null,
  kind: 'PUBLIC' as const,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findHolidaysInYear.mockResolvedValue([holiday()]);
  repository.findHolidaysInRange.mockResolvedValue([holiday()]);
  repository.findHolidayOn.mockResolvedValue(null);
  repository.findHolidayById.mockResolvedValue(holiday());
  repository.createHoliday.mockImplementation(async (data: Record<string, unknown>) => holiday({ id: 'hol_2', ...data }));
  repository.updateHoliday.mockImplementation(async (_id: string, data: Record<string, unknown>) => holiday(data));
  repository.removeHoliday.mockResolvedValue(holiday());
  employees.listActiveEmployeesForDirectory.mockResolvedValue([]);
  agents.listActiveAgentsForDirectory.mockResolvedValue([]);
  employees.findEmployeeByUserId.mockResolvedValue(null);
  agents.findAgentProfile.mockResolvedValue(null);
});

describe('holidays', () => {
  it('is ADMIN at the router', async () => {
    const res = await request(app()).get('/api/v1/hr/holidays?year=2026').set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it('lists a year as plain dates', async () => {
    const res = await request(app()).get('/api/v1/hr/holidays?year=2026').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.findHolidaysInYear).toHaveBeenCalledWith(2026);
    expect(res.body.data).toEqual([{ id: 'hol_1', date: '2026-10-02', name: 'Gandhi Jayanti', region: null, kind: 'PUBLIC' }]);
  });

  it('refuses a year it cannot draw', async () => {
    const res = await request(app()).get('/api/v1/hr/holidays?year=26').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
  });

  it('creates one, audited with its target, and refuses the same day twice', async () => {
    const res = await request(app())
      .post('/api/v1/hr/holidays')
      .set('Authorization', `Bearer ${admin}`)
      .send({ date: '2026-11-08', name: 'Diwali' });
    expect(res.status).toBe(201);
    expect(repository.createHoliday).toHaveBeenCalledWith({ date: new Date('2026-11-08T00:00:00.000Z'), name: 'Diwali', region: null, kind: 'PUBLIC' });
    expect(res.body.data).toMatchObject({ date: '2026-11-08', name: 'Diwali', region: null });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'HOLIDAY_CREATED',
      expect.objectContaining({ module: 'hr', targetType: 'Holiday', targetId: 'hol_2' }),
    );

    repository.findHolidayOn.mockResolvedValue(holiday());
    const dup = await request(app())
      .post('/api/v1/hr/holidays')
      .set('Authorization', `Bearer ${admin}`)
      .send({ date: '2026-10-02', name: 'Gandhi Jayanti' });
    expect(dup.status).toBe(409);
  });

  it('keeps a regional day apart from the national one on the same date', async () => {
    const res = await request(app())
      .post('/api/v1/hr/holidays')
      .set('Authorization', `Bearer ${admin}`)
      .send({ date: '2026-10-02', name: 'Gandhi Jayanti', region: ' KA ' });
    expect(res.status).toBe(201);
    expect(repository.findHolidayOn).toHaveBeenCalledWith(new Date('2026-10-02T00:00:00.000Z'), 'KA');
  });

  it('patches and deletes, each leaving a row in the trail', async () => {
    const patched = await request(app())
      .patch('/api/v1/hr/holidays/hol_1')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Gandhi Jayanti (observed)' });
    expect(patched.status).toBe(200);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'HOLIDAY_UPDATED',
      expect.objectContaining({ targetType: 'Holiday', targetId: 'hol_1', diff: expect.objectContaining({ name: expect.anything() }) }),
    );

    const deleted = await request(app()).delete('/api/v1/hr/holidays/hol_1').set('Authorization', `Bearer ${admin}`);
    expect(deleted.status).toBe(200);
    expect(repository.removeHoliday).toHaveBeenCalledWith('hol_1');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'HOLIDAY_DELETED', expect.objectContaining({ targetId: 'hol_1' }));

    repository.findHolidayById.mockResolvedValue(null);
    const missing = await request(app()).delete('/api/v1/hr/holidays/hol_9').set('Authorization', `Bearer ${admin}`);
    expect(missing.status).toBe(404);
  });

  it('refuses a patch that says nothing, and an end before a start of a date it cannot parse', async () => {
    const empty = await request(app()).patch('/api/v1/hr/holidays/hol_1').set('Authorization', `Bearer ${admin}`).send({});
    expect(empty.status).toBe(400);
    const bad = await request(app()).post('/api/v1/hr/holidays').set('Authorization', `Bearer ${admin}`).send({ date: '2026-13-40', name: 'X' });
    expect(bad.status).toBe(400);
  });

  it('reads a range for the diary as the same view', async () => {
    const rows = await holidaysInRange('2026-10-01', '2026-10-31');
    expect(repository.findHolidaysInRange).toHaveBeenCalledWith(new Date('2026-10-01T00:00:00.000Z'), new Date('2026-10-31T00:00:00.000Z'));
    expect(rows).toEqual([toHolidayView(holiday())]);
  });
});

describe('ensureHolidays — the boot seed', () => {
  it('inserts only the days that are missing, and never touches a name', async () => {
    repository.findHolidayOn.mockImplementation(async (date: Date) =>
      date.toISOString().startsWith('2026-01-26') ? holiday({ name: 'Republic Day (renamed by ops)' }) : null,
    );
    const inserted = await ensureHolidays();
    expect(inserted).toBe(HOLIDAYS_2026.length - 1);
    expect(repository.createHoliday).toHaveBeenCalledTimes(HOLIDAYS_2026.length - 1);
    expect(repository.updateHoliday).not.toHaveBeenCalled();
    expect(repository.createHoliday).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Republic Day' }));
  });

  it('is a no-op the second time', async () => {
    repository.findHolidayOn.mockResolvedValue(holiday());
    expect(await ensureHolidays()).toBe(0);
    expect(repository.createHoliday).not.toHaveBeenCalled();
  });

  it('carries the three national days at least', () => {
    const dates = HOLIDAYS_2026.map((h) => h.date);
    expect(dates).toEqual(expect.arrayContaining(['2026-01-26', '2026-08-15', '2026-10-02']));
    expect(new Set(dates).size).toBe(dates.length);
  });
});

describe('the people registry', () => {
  it('unions active staff and ACTIVE agents, each row saying which', async () => {
    employees.listActiveEmployeesForDirectory.mockResolvedValue([
      { userId: 'usr_1', name: 'Asha', designation: 'Coordinator', department: 'Ops', active: true },
    ]);
    agents.listActiveAgentsForDirectory.mockResolvedValue([
      { userId: 'usr_2', agentProfileId: 'agt_2', name: 'Ravi', tier: 'GOLD II', city: 'Bengaluru', active: true },
    ]);
    const res = await request(app()).get('/api/v1/hr/people?q=a').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    // E10-1: the switch for the inactive is off unless asked; every row says whether it is active.
    expect(employees.listActiveEmployeesForDirectory).toHaveBeenCalledWith('a', { includeInactive: false });
    expect(agents.listActiveAgentsForDirectory).toHaveBeenCalledWith('a', { includeInactive: false });
    expect(res.body.data).toEqual([
      { userId: 'usr_1', name: 'Asha', kind: 'STAFF', designation: 'Coordinator', department: 'Ops', active: true },
      { userId: 'usr_2', name: 'Ravi', kind: 'AGENT', tier: 'GOLD II', agentProfileId: 'agt_2', active: true },
    ]);
  });

  it('asks only one side when kind is given', async () => {
    await listPeople({ kind: 'AGENT', active: true });
    expect(employees.listActiveEmployeesForDirectory).not.toHaveBeenCalled();
    expect(agents.listActiveAgentsForDirectory).toHaveBeenCalled();
  });

  it('refuses a kind it does not have', async () => {
    const res = await request(app()).get('/api/v1/hr/people?kind=VENDOR').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(400);
  });

  it('finds one person for the diary: staff, agent, or nobody', async () => {
    employees.findEmployeeByUserId.mockResolvedValue({ id: 'emp_1', userId: 'usr_1', isActive: true });
    expect(await findPerson('usr_1')).toEqual({ userId: 'usr_1', kind: 'STAFF', agentProfileId: null });

    employees.findEmployeeByUserId.mockResolvedValue(null);
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_2', userId: 'usr_2', status: 'ACTIVE' });
    expect(await findPerson('usr_2')).toEqual({ userId: 'usr_2', kind: 'AGENT', agentProfileId: 'agt_2' });

    agents.findAgentProfile.mockResolvedValue({ id: 'agt_3', userId: 'usr_3', status: 'SUSPENDED' });
    expect(await findPerson('usr_3')).toBeNull();

    employees.findEmployeeByUserId.mockResolvedValue({ id: 'emp_4', userId: 'usr_4', isActive: false });
    agents.findAgentProfile.mockResolvedValue(null);
    expect(await findPerson('usr_4')).toBeNull();
  });
});
