import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E (Q99) — the staff diary and its field overlay.
 *
 * What is pinned: the diary is ADMIN-only; an entry is put against a person
 * the registry knows (staff or agent) and nobody else; the window read
 * returns the entries, the holidays that shade it, and — only when the
 * caller names the tables and the person is an agent — that agent's field
 * work as read-only rows; every write is audited `SCHEDULE_ENTRY_*` with its
 * target; and the log is the trail read back by those actions, never
 * deletable from here.
 */

const { repository, hr, visits, audit } = vi.hoisted(() => ({
  repository: {
    findInRange: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  hr: { holidaysInRange: vi.fn(), findPerson: vi.fn() },
  visits: { agentWorkInWindow: vi.fn() },
  audit: { logActivity: vi.fn(), findActivity: vi.fn() },
}));

vi.mock('../prisma-schedule.repository', () => ({ prismaScheduleRepository: repository }));
vi.mock('../../hr', () => hr);
vi.mock('../../visits', () => visits);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { scheduleRouter } from '../schedule.routes';
import { createEntrySchema, scheduleQuerySchema } from '../schedule.schema';

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
const agentToken = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

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
  repository.findInRange.mockResolvedValue([entry()]);
  repository.findById.mockResolvedValue(entry());
  repository.create.mockImplementation(async (data: Record<string, unknown>) => entry({ id: 'sch_2', ...data }));
  repository.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => entry(data));
  repository.remove.mockResolvedValue(entry());
  hr.holidaysInRange.mockResolvedValue([{ id: 'hol_1', date: '2026-09-15', name: 'Regional day', region: 'KA' }]);
  hr.findPerson.mockResolvedValue({ userId: 'usr_1', kind: 'STAFF', agentProfileId: null });
  visits.agentWorkInWindow.mockResolvedValue([]);
  audit.findActivity.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50, counts: {} });
});

describe('the schema', () => {
  it('reads the window, the person and the include list', () => {
    expect(scheduleQuerySchema.parse({ from: '2026-09-14', to: '2026-09-20', assigneeUserId: 'usr_1', include: 'visits,jobs' })).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
      assigneeUserId: 'usr_1',
      include: { visits: true, milestones: false, jobs: true },
    });
    expect(scheduleQuerySchema.parse({ from: '2026-09-14', to: '2026-09-20' }).include).toEqual({ visits: false, milestones: false, jobs: false });
    expect(scheduleQuerySchema.safeParse({ from: '2026-09-20', to: '2026-09-14' }).success).toBe(false);
    expect(scheduleQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(false);
    expect(scheduleQuerySchema.safeParse({ from: '2026-09-14', to: '2026-09-20', include: 'leave' }).success).toBe(false);
  });

  it('refuses an end before the start and a time it cannot read', () => {
    const base = { date: '2026-09-14', title: 'X', assigneeUserId: 'usr_1' };
    expect(createEntrySchema.safeParse({ ...base, startTime: '10:00', endTime: '09:30' }).success).toBe(false);
    expect(createEntrySchema.safeParse({ ...base, startTime: '25:00' }).success).toBe(false);
    expect(createEntrySchema.safeParse({ ...base, startTime: '10:00' }).success).toBe(true);
  });
});

describe('GET /schedule', () => {
  it('is ADMIN-only', async () => {
    const res = await request(app()).get('/api/v1/schedule?from=2026-09-14&to=2026-09-20').set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it('returns the entries in the window beside the holidays, with no overlay unless asked', async () => {
    const res = await request(app())
      .get('/api/v1/schedule?from=2026-09-14&to=2026-09-20&assigneeUserId=usr_1')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.findInRange).toHaveBeenCalledWith(new Date('2026-09-14T00:00:00.000Z'), new Date('2026-09-20T00:00:00.000Z'), 'usr_1');
    expect(hr.holidaysInRange).toHaveBeenCalledWith('2026-09-14', '2026-09-20');
    expect(res.body.data).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
      entries: [
        expect.objectContaining({ id: 'sch_1', date: '2026-09-14', startTime: '10:00', endTime: '11:00', title: 'Ops stand-up', status: 'PENDING' }),
      ],
      holidays: [{ id: 'hol_1', date: '2026-09-15', name: 'Regional day', region: 'KA' }],
      overlay: [],
    });
    expect(visits.agentWorkInWindow).not.toHaveBeenCalled();
  });

  it('overlays the agent’s field work over the range when asked and the person is an agent', async () => {
    hr.findPerson.mockResolvedValue({ userId: 'usr_2', kind: 'AGENT', agentProfileId: 'agt_2' });
    visits.agentWorkInWindow.mockResolvedValue([
      { kind: 'FIELD_VISIT', id: 'vst_1', title: 'Audit · Nilgiri', where: 'Indiranagar', at: '2026-09-15T04:30:00.000Z', status: 'SCHEDULED', link: '/visits/vst_1' },
    ]);
    const res = await request(app())
      .get('/api/v1/schedule?from=2026-09-14&to=2026-09-20&assigneeUserId=usr_2&include=visits,milestones')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(visits.agentWorkInWindow).toHaveBeenCalledWith(
      'agt_2',
      { start: new Date('2026-09-13T18:30:00.000Z'), end: new Date('2026-09-20T18:30:00.000Z') },
      { visits: true, milestones: true, jobs: false },
      expect.any(Date),
    );
    expect(res.body.data.overlay).toEqual([expect.objectContaining({ kind: 'FIELD_VISIT', id: 'vst_1', link: '/visits/vst_1' })]);
  });

  it('shows no overlay for a staffer with no agent profile, or when no person is selected', async () => {
    await request(app())
      .get('/api/v1/schedule?from=2026-09-14&to=2026-09-20&assigneeUserId=usr_1&include=visits')
      .set('Authorization', `Bearer ${admin}`);
    await request(app()).get('/api/v1/schedule?from=2026-09-14&to=2026-09-20&include=visits').set('Authorization', `Bearer ${admin}`);
    expect(visits.agentWorkInWindow).not.toHaveBeenCalled();
  });
});

describe('the writes', () => {
  it('creates an entry against a known person, stamped with who wrote it, and audits it', async () => {
    const res = await request(app())
      .post('/api/v1/schedule')
      .set('Authorization', `Bearer ${admin}`)
      .send({ date: '2026-09-14', startTime: '10:00', endTime: '11:00', title: 'Ops stand-up', assigneeUserId: 'usr_1', department: 'Ops' });
    expect(res.status).toBe(201);
    expect(hr.findPerson).toHaveBeenCalledWith('usr_1');
    expect(repository.create).toHaveBeenCalledWith({
      date: new Date('2026-09-14T00:00:00.000Z'),
      startTime: '10:00',
      endTime: '11:00',
      title: 'Ops stand-up',
      notes: null,
      assigneeUserId: 'usr_1',
      department: 'Ops',
      createdByUserId: 'adm_1',
    });
    expect(res.body.data).toMatchObject({ id: 'sch_2', date: '2026-09-14', status: 'PENDING' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'SCHEDULE_ENTRY_CREATED',
      expect.objectContaining({ module: 'schedule', targetType: 'ScheduleEntry', targetId: 'sch_2' }),
    );
  });

  it('refuses a person the registry does not know', async () => {
    hr.findPerson.mockResolvedValue(null);
    const res = await request(app())
      .post('/api/v1/schedule')
      .set('Authorization', `Bearer ${admin}`)
      .send({ date: '2026-09-14', startTime: '10:00', title: 'X', assigneeUserId: 'usr_ghost' });
    expect(res.status).toBe(404);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('patches with a diff in the trail, checks a new assignee, and refuses an end before the start', async () => {
    const res = await request(app())
      .patch('/api/v1/schedule/sch_1')
      .set('Authorization', `Bearer ${admin}`)
      .send({ status: 'IN_PROGRESS', assigneeUserId: 'usr_2' });
    expect(res.status).toBe(200);
    expect(hr.findPerson).toHaveBeenCalledWith('usr_2');
    expect(repository.update).toHaveBeenCalledWith('sch_1', { status: 'IN_PROGRESS', assigneeUserId: 'usr_2' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'SCHEDULE_ENTRY_UPDATED',
      expect.objectContaining({ targetId: 'sch_1', diff: expect.objectContaining({ status: { before: 'PENDING', after: 'IN_PROGRESS' } }) }),
    );

    const bad = await request(app()).patch('/api/v1/schedule/sch_1').set('Authorization', `Bearer ${admin}`).send({ endTime: '09:00' });
    expect(bad.status).toBe(400);
  });

  it('deletes, audited, and 404s on nothing', async () => {
    const res = await request(app()).delete('/api/v1/schedule/sch_1').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.remove).toHaveBeenCalledWith('sch_1');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'SCHEDULE_ENTRY_DELETED', expect.objectContaining({ targetId: 'sch_1' }));

    repository.findById.mockResolvedValue(null);
    expect((await request(app()).delete('/api/v1/schedule/sch_9').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
  });
});

describe('GET /schedule/log', () => {
  it('reads the trail by the schedule actions in the window', async () => {
    audit.findActivity.mockResolvedValue({
      items: [
        { id: 'act_1', action: 'SCHEDULE_ENTRY_CREATED', targetId: 'sch_1', module: 'schedule', createdAt: new Date('2026-09-14T05:00:00.000Z'), diff: null, metadata: { title: 'Ops stand-up' }, user: { id: 'adm_1', name: 'Admin', email: null } },
        { id: 'act_2', action: 'ADMIN_WRITE', targetId: 'x', module: 'schedule', createdAt: new Date('2026-09-14T05:00:00.000Z'), diff: null, metadata: null, user: { id: 'adm_1', name: 'Admin', email: null } },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      counts: {},
    });
    const res = await request(app()).get('/api/v1/schedule/log?from=2026-09-14&to=2026-09-20').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(audit.findActivity).toHaveBeenCalledWith(
      { module: 'schedule', from: new Date('2026-09-13T18:30:00.000Z'), to: new Date('2026-09-20T18:30:00.000Z') },
      { page: 1, pageSize: 50, sort: 'newest' },
    );
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ id: 'act_1', action: 'SCHEDULE_ENTRY_CREATED', targetId: 'sch_1', actor: { id: 'adm_1', name: 'Admin' } }),
    ]);
  });
});
