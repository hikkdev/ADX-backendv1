import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: `GET /hr/people?includeInactive=true` — the registry with the
 * people who have left: inactive employees and non-ACTIVE agents, each row
 * flagged `active: false`, so the diary can still name whoever an old entry
 * was put against. Without the switch the registry lists the active only,
 * every row `active: true`, as it always did.
 */

const { repository, employees, agents } = vi.hoisted(() => ({
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
}));

vi.mock('../prisma-hr.repository', () => ({ prismaHrRepository: repository }));
vi.mock('../../employees', () => employees);
vi.mock('../../agents', () => agents);

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { hrRouter } from '../hr.routes';
import { peopleQuerySchema } from '../hr.schema';

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

beforeEach(() => {
  vi.clearAllMocks();
  employees.listActiveEmployeesForDirectory.mockResolvedValue([
    { userId: 'usr_1', name: 'Asha', designation: 'Coordinator', department: 'Ops', active: true },
    { userId: 'usr_3', name: 'Bala', designation: 'Former', department: 'Ops', active: false },
  ]);
  agents.listActiveAgentsForDirectory.mockResolvedValue([
    { userId: 'usr_2', agentProfileId: 'agt_2', name: 'Ravi', tier: 'GOLD II', city: 'Bengaluru', active: true },
    { userId: 'usr_4', agentProfileId: 'agt_4', name: 'Dev', tier: 'BRONZE I', city: 'Pune', active: false },
  ]);
});

describe('the query', () => {
  it('reads includeInactive as a switch, off by default', () => {
    expect(peopleQuerySchema.parse({}).includeInactive).toBe(false);
    expect(peopleQuerySchema.parse({ includeInactive: 'true' }).includeInactive).toBe(true);
    expect(peopleQuerySchema.parse({ includeInactive: 'false' }).includeInactive).toBe(false);
  });
});

describe('GET /hr/people', () => {
  it('lists the active only by default, every row active:true', async () => {
    // The two modules answer only the active when the switch is off.
    employees.listActiveEmployeesForDirectory.mockResolvedValue([
      { userId: 'usr_1', name: 'Asha', designation: 'Coordinator', department: 'Ops', active: true },
    ]);
    agents.listActiveAgentsForDirectory.mockResolvedValue([
      { userId: 'usr_2', agentProfileId: 'agt_2', name: 'Ravi', tier: 'GOLD II', city: 'Bengaluru', active: true },
    ]);
    const res = await request(app()).get('/api/v1/hr/people?q=a').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(employees.listActiveEmployeesForDirectory).toHaveBeenCalledWith('a', { includeInactive: false });
    expect(agents.listActiveAgentsForDirectory).toHaveBeenCalledWith('a', { includeInactive: false });
    expect(res.body.data.every((row: { active: boolean }) => row.active === true)).toBe(true);
    expect(res.body.data.map((row: { userId: string }) => row.userId)).toEqual(['usr_1', 'usr_2']);
  });

  it('includes the inactive when asked, flagged active:false', async () => {
    const res = await request(app()).get('/api/v1/hr/people?includeInactive=true').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(employees.listActiveEmployeesForDirectory).toHaveBeenCalledWith(undefined, { includeInactive: true });
    expect(agents.listActiveAgentsForDirectory).toHaveBeenCalledWith(undefined, { includeInactive: true });
    expect(res.body.data).toEqual([
      { userId: 'usr_1', name: 'Asha', kind: 'STAFF', designation: 'Coordinator', department: 'Ops', active: true },
      { userId: 'usr_3', name: 'Bala', kind: 'STAFF', designation: 'Former', department: 'Ops', active: false },
      { userId: 'usr_4', name: 'Dev', kind: 'AGENT', tier: 'BRONZE I', agentProfileId: 'agt_4', active: false },
      { userId: 'usr_2', name: 'Ravi', kind: 'AGENT', tier: 'GOLD II', agentProfileId: 'agt_2', active: true },
    ]);
  });
});
