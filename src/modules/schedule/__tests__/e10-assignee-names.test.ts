import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: the diary names its people. Every entry in the window and every
 * log row carries `assignee { id, name }` beside the id, through
 * `users.findUserLabels` — one lookup per read, active or not, because an
 * old entry against a person who has since left still has to say who.
 */

const { repository, hr, visits, users, audit } = vi.hoisted(() => ({
  repository: { findInRange: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  hr: { holidaysInRange: vi.fn(async () => []), findPerson: vi.fn() },
  visits: { agentWorkInWindow: vi.fn() },
  users: {
    findUserLabels: vi.fn(async (ids: readonly string[]) => {
      const names: Record<string, string> = { usr_1: 'Asha', usr_left: 'Bala (left)' };
      return new Map(ids.map((id) => [id, { id, name: names[id] ?? null }]));
    }),
  },
  audit: { logActivity: vi.fn(), findActivity: vi.fn() },
}));

vi.mock('../prisma-schedule.repository', () => ({ prismaScheduleRepository: repository }));
vi.mock('../../hr', () => hr);
vi.mock('../../visits', () => visits);
vi.mock('../../users', () => users);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { scheduleRouter } from '../schedule.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/schedule', scheduleRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'sch_1',
  date: new Date('2026-09-14T00:00:00.000Z'),
  startTime: '10:00',
  endTime: '11:00',
  title: 'Ops stand-up',
  notes: null,
  assigneeUserId: 'usr_1',
  department: 'Ops',
  status: 'PENDING',
  createdByUserId: 'adm_1',
  createdAt: new Date('2026-09-12T06:00:00.000Z'),
  updatedAt: new Date('2026-09-12T06:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /schedule — assignee on every entry', () => {
  it('names each assignee in one lookup, a person who left included', async () => {
    repository.findInRange.mockResolvedValue([
      entry(),
      entry({ id: 'sch_2', assigneeUserId: 'usr_left' }),
      entry({ id: 'sch_3', assigneeUserId: 'usr_gone' }),
    ]);
    const res = await request(app()).get('/api/v1/schedule?from=2026-09-14&to=2026-09-20').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(users.findUserLabels).toHaveBeenCalledTimes(1);
    expect(users.findUserLabels).toHaveBeenCalledWith(['usr_1', 'usr_left', 'usr_gone']);
    expect(res.body.data.entries.map((row: { id: string; assigneeUserId: string; assignee: unknown }) => [row.id, row.assigneeUserId, row.assignee])).toEqual([
      ['sch_1', 'usr_1', { id: 'usr_1', name: 'Asha' }],
      ['sch_2', 'usr_left', { id: 'usr_left', name: 'Bala (left)' }],
      ['sch_3', 'usr_gone', { id: 'usr_gone', name: null }],
    ]);
  });

  it('asks for no names on an empty window', async () => {
    repository.findInRange.mockResolvedValue([]);
    const res = await request(app()).get('/api/v1/schedule?from=2026-09-14&to=2026-09-20').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
    expect(users.findUserLabels).not.toHaveBeenCalled();
  });
});

describe('GET /schedule/log — assignee on every row', () => {
  it('names the assignee the row was written against, null when the row names nobody', async () => {
    audit.findActivity.mockResolvedValue({
      items: [
        { id: 'act_1', action: 'SCHEDULE_ENTRY_CREATED', targetId: 'sch_1', module: 'schedule', createdAt: new Date('2026-09-14T05:00:00.000Z'), diff: null, metadata: { title: 'Ops stand-up', assigneeUserId: 'usr_left' }, user: { id: 'adm_1', name: 'Admin', email: null } },
        { id: 'act_2', action: 'SCHEDULE_ENTRY_DELETED', targetId: 'sch_0', module: 'schedule', createdAt: new Date('2026-09-14T05:00:00.000Z'), diff: null, metadata: { title: 'Old' }, user: { id: 'adm_1', name: 'Admin', email: null } },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      counts: {},
    });
    const res = await request(app()).get('/api/v1/schedule/log?from=2026-09-14&to=2026-09-20').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(users.findUserLabels).toHaveBeenCalledWith(['usr_left']);
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ id: 'act_1', actor: { id: 'adm_1', name: 'Admin' }, assignee: { id: 'usr_left', name: 'Bala (left)' } }),
      expect.objectContaining({ id: 'act_2', assignee: null }),
    ]);
  });
});
