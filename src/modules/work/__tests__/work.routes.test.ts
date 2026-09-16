import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Work — Lot AA (Q70: essentials only; the owner's "there was a Tasks
 * section in DR 10").
 *
 * Pinned over the in-memory repository: the people rule (employees and
 * agents, 422 for anyone else); PRJ-/TSK-/ISS- minted through identifiers;
 * the list facets and the chip counts; every status rule; the review rule;
 * the parent rollup; the cycle check; time-log ownership; issue resolve and
 * the blockedByIssue flag; the overview maths; the board cap; `/me`
 * scoping; the notices; and the recurrence spawn. Every ADMIN write leaves
 * an audit row under `work`.
 */

const { audit, notifications, identifiers, cache } = vi.hoisted(() => ({
  audit: { logActivity: vi.fn(async () => undefined) },
  notifications: { notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: null, deliveries: [] })) },
  identifiers: { allocateIdentifier: vi.fn() },
  cache: { redis: { set: vi.fn(async (): Promise<string | null> => 'OK'), del: vi.fn(async () => 1) } },
}));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { signAccessToken } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { workRouter } from '../work.routes';
import { setWorkRepository } from '../work.service';
import { InMemoryWorkRepository } from './in-memory-work.repository';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/work', workRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');
/** An admin whose role config holds view + edit but not approve. */
const editor = signAccessToken('usr_admin', ['ADMIN'], undefined, { perms: ['work.view', 'work.edit'] });
const approver = signAccessToken('usr_admin', ['ADMIN'], undefined, { perms: ['work.view', 'work.edit', 'work.approve'] });
const asha = tokenFor(['ADMIN'], 'usr_asha');
const chitra = tokenFor(['AGENT_PUBLISHER'], 'usr_chitra');
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

const NOW = new Date('2026-09-15T06:00:00.000Z');

let repo: InMemoryWorkRepository;

const api = () => request(app());
const get = (path: string, token = admin) => api().get(`/api/v1/work${path}`).set('Authorization', `Bearer ${token}`);
const post = (path: string, body: unknown, token = admin) => api().post(`/api/v1/work${path}`).set('Authorization', `Bearer ${token}`).send(body as object);
const put = (path: string, body: unknown, token = admin) => api().put(`/api/v1/work${path}`).set('Authorization', `Bearer ${token}`).send(body as object);
const patch = (path: string, body: unknown, token = admin) => api().patch(`/api/v1/work${path}`).set('Authorization', `Bearer ${token}`).send(body as object);
const del = (path: string, token = admin) => api().delete(`/api/v1/work${path}`).set('Authorization', `Bearer ${token}`);

type AuditCall = [string, string, Record<string, unknown>];
const audited = (action: string) => (audit.logActivity.mock.calls as unknown as AuditCall[]).filter((call) => call[1] === action);
type NotifyCall = [string, string, Record<string, unknown>, Record<string, unknown>];
const notifyCalls = () => notifications.notify.mock.calls as unknown as NotifyCall[];
const notified = (event: string) => notifyCalls().filter((call) => call[0] === event).map((call) => call[1]);

async function createTask(body: Record<string, unknown>, token = admin) {
  const res = await post('/tasks', { title: 'Audit the Indiranagar hoardings', ...body }, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; displayId: string; status: string };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock: faking the timers would stall supertest.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  repo = new InMemoryWorkRepository();
  repo.clock = NOW;
  setWorkRepository(repo);
  repo.person({ userId: 'usr_admin', name: 'Ops Admin', role: 'Operations lead', departmentName: 'Operations' });
  repo.person({ userId: 'usr_asha', name: 'Asha Rao', role: 'City manager', departmentName: 'Operations' });
  repo.person({ userId: 'usr_bala', name: 'Bala Iyer', role: 'Designer', departmentName: 'Creative' });
  repo.person({ userId: 'usr_chitra', name: 'Chitra Nair', kind: 'AGENT', role: 'Field agent' });
  repo.person({ userId: 'usr_left', name: 'Left Person', active: false });
  repo.departments.push({ id: 'dep_ops', name: 'Operations' });
  repo.cities.push({ id: 'cty_blr', name: 'Bengaluru' });
  repo.linked.set('ORDER:ord_1', 'Diwali push');
  const counters: Record<string, number> = {};
  const prefixes: Record<string, string> = { PROJECT: 'PRJ', TASK: 'TSK', ISSUE: 'ISS' };
  identifiers.allocateIdentifier.mockImplementation(async (party: string) => {
    counters[party] = (counters[party] ?? 0) + 1;
    return `${prefixes[party]}-${String(counters[party]).padStart(4, '0')}`;
  });
});

/* ── the door ─────────────────────────────────────────────────────── */

describe('the door', () => {
  it('is ADMIN + work.view on the desk, and any employee or agent session on /me', async () => {
    expect((await get('/tasks', publisher)).status).toBe(403);
    expect((await get('/tasks', chitra)).status).toBe(403);
    const noView = signAccessToken('usr_admin', ['ADMIN'], undefined, { perms: ['hr.view'] });
    expect((await get('/tasks', noView)).status).toBe(403);
    expect((await get('/me/tasks', chitra)).status).toBe(200);
    expect((await get('/me/tasks', asha)).status).toBe(200);
    expect((await get('/me/tasks', publisher)).status).toBe(403);
    expect((await get('/me/summary', chitra)).body.data).toEqual({ open: 0, dueToday: 0, overdue: 0, awaitingMyReview: 0 });
  });

  it('needs work.edit for a write', async () => {
    const view = signAccessToken('usr_admin', ['ADMIN'], undefined, { perms: ['work.view'] });
    expect((await get('/tasks', view)).status).toBe(200);
    expect((await post('/tasks', { title: 'X' }, view)).status).toBe(403);
  });
});

/* ── people ───────────────────────────────────────────────────────── */

describe('people', () => {
  it('lists the assignee picker over employees and agents, by name and kind', async () => {
    const res = await get('/people?q=a');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { userId: string }) => p.userId)).toEqual(['usr_admin', 'usr_asha', 'usr_bala', 'usr_chitra']);
    expect(res.body.data[3]).toEqual({ userId: 'usr_chitra', name: 'Chitra Nair', kind: 'AGENT', role: 'Field agent', departmentName: null });
    const agents = await get('/people?kind=AGENT');
    expect(agents.body.data).toEqual([expect.objectContaining({ userId: 'usr_chitra' })]);
  });

  it('refuses a person who is neither an active employee nor an active agent, naming the ids', async () => {
    const res = await post('/tasks', { title: 'X', assigneeUserIds: ['usr_asha', 'usr_left', 'usr_ghost'] });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ userIds: ['usr_left', 'usr_ghost'] });
    expect(repo.tasks).toHaveLength(0);
  });
});

/* ── projects ─────────────────────────────────────────────────────── */

describe('projects', () => {
  it('mints PRJ-, wants a department for DEPARTMENT and a city for REGION, and audits', async () => {
    expect((await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', ownerUserId: 'usr_asha' })).status).toBe(400);
    expect((await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_nope', ownerUserId: 'usr_asha' })).status).toBe(404);
    expect((await post('/projects', { name: 'BLR launch', kind: 'REGION', cityId: 'cty_nope', ownerUserId: 'usr_asha' })).status).toBe(404);
    expect((await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_ghost' })).status).toBe(422);

    const res = await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha', startsAt: '2026-10-01' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ displayId: 'PRJ-0001', kind: 'DEPARTMENT', departmentId: 'dep_ops', cityId: null, status: 'ACTIVE', owner: { userId: 'usr_asha', name: 'Asha Rao' } });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('PROJECT');
    expect(audited('WORK_PROJECT_CREATED')[0]![2]).toMatchObject({ module: 'work', targetType: 'WorkProject', targetId: res.body.data.id });

    const region = await post('/projects', { name: 'BLR launch', kind: 'REGION', cityId: 'cty_blr', ownerUserId: 'usr_asha' });
    expect(region.body.data).toMatchObject({ displayId: 'PRJ-0002', cityId: 'cty_blr', departmentId: null });
  });

  it('lists with the chip counts, reads the detail with counts, patches with a diff, archives', async () => {
    const { body } = await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' });
    const id = body.data.id as string;
    await createTask({ projectId: id, status: 'TODO' });
    await createTask({ projectId: id, status: 'DRAFT' });
    const task = await createTask({ projectId: id, assigneeUserIds: ['usr_asha'] });
    await post(`/tasks/${task.id}/time-logs`, { forDate: '2026-09-14', hours: 2.5 }, asha);
    await post('/issues', { title: 'Vendor late', taskId: task.id, severity: 'HIGH' });

    const detail = await get(`/projects/${id}`);
    expect(detail.body.data.counts).toEqual({ tasks: { DRAFT: 1, TODO: 2, IN_PROGRESS: 0, PENDING_REVIEW: 0, VERIFIED: 0, BLOCKED: 0, ARCHIVED: 0 }, openIssues: 1, hoursLogged: 2.5 });

    const patched = await patch(`/projects/${id}`, { name: 'Ops Q4 (revised)', cityId: 'cty_blr' });
    expect(patched.status).toBe(409);
    const ok = await patch(`/projects/${id}`, { name: 'Ops Q4 (revised)' });
    expect(ok.status).toBe(200);
    expect(audited('WORK_PROJECT_UPDATED')[0]![2]).toMatchObject({ diff: { name: { before: 'Ops Q4', after: 'Ops Q4 (revised)' } } });

    expect((await post(`/projects/${id}/archive`, {})).body.data.status).toBe('ARCHIVED');
    expect((await post(`/projects/${id}/archive`, {})).status).toBe(409);
    const list = await get('/projects?kind=DEPARTMENT');
    expect(list.body.data).toMatchObject({ total: 1, counts: { ACTIVE: 0, ARCHIVED: 1 } });
    expect((await get('/projects?status=ACTIVE')).body.data.total).toBe(0);
  });
});

/* ── tasks ────────────────────────────────────────────────────────── */

describe('tasks', () => {
  it('mints TSK-, stamps the creator, notifies each assignee, and reads back the whole record', async () => {
    const res = await post('/tasks', {
      title: 'Audit the Indiranagar hoardings',
      description: 'All 14 faces',
      priority: 'HIGH',
      deadline: '2026-09-20',
      effortEstimateH: 6,
      linkedKind: 'ORDER',
      linkedId: 'ord_1',
      tags: ['audit'],
      assigneeUserIds: ['usr_asha', 'usr_chitra'],
      reviewers: [{ userId: 'usr_bala', approver: true }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      displayId: 'TSK-0001',
      status: 'TODO',
      priority: 'HIGH',
      progress: 0,
      deadline: '2026-09-20T18:29:59.999Z',
      effortEstimateH: 6,
      overdue: false,
      blockedByIssue: false,
      createdBy: { userId: 'usr_admin', name: 'Ops Admin' },
      assignees: [expect.objectContaining({ userId: 'usr_asha', kind: 'EMPLOYEE', role: 'City manager' }), expect.objectContaining({ userId: 'usr_chitra', kind: 'AGENT' })],
      reviewers: [expect.objectContaining({ userId: 'usr_bala', approver: true, approvedAt: null })],
      linked: { kind: 'ORDER', id: 'ord_1', label: 'Diwali push' },
      timeLogs: { rows: [], totals: { hours: 0, billableHours: 0 } },
    });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('TASK');
    expect(notified('WORK_ASSIGNED')).toEqual(['usr_asha', 'usr_chitra']);
    expect(notifyCalls()[0]![3]).toMatchObject({ type: 'WORK', inApp: expect.objectContaining({ type: 'WORK', relatedType: 'WORK', relatedId: res.body.data.id }) });
    expect(audited('WORK_TASK_CREATED')).toHaveLength(1);
  });

  it('refuses a linked record that does not exist, naming it', async () => {
    const res = await post('/tasks', { title: 'X', linkedKind: 'LISTING', linkedId: 'lst_9' });
    expect(res.status).toBe(404);
    expect(res.body.error.details).toEqual({ linkedKind: 'LISTING', linkedId: 'lst_9' });
    expect((await post('/tasks', { title: 'X', linkedKind: 'LISTING' })).status).toBe(400);
  });

  it('a sub-task inherits its parent’s project and cannot name another', async () => {
    const project = (await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' })).body.data.id;
    const other = (await post('/projects', { name: 'Other', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' })).body.data.id;
    const parent = await createTask({ projectId: project });
    expect((await post('/tasks', { title: 'Sub', parentTaskId: parent.id, projectId: other })).status).toBe(409);
    const child = await createTask({ title: 'Sub', parentTaskId: parent.id });
    const detail = await get(`/tasks/${child.id}`);
    expect(detail.body.data.project.id).toBe(project);
    expect(detail.body.data.parent).toEqual({ id: parent.id, displayId: 'TSK-0001', title: 'Audit the Indiranagar hoardings' });
    expect((await patch(`/tasks/${child.id}`, { projectId: other })).status).toBe(409);
    expect((await get(`/tasks/${parent.id}`)).body.data.children).toEqual([expect.objectContaining({ id: child.id, status: 'TODO', progress: 0 })]);
  });

  it('lists by the facets with the counts taken over the filter minus its status', async () => {
    const project = (await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' })).body.data.id;
    const a = await createTask({ title: 'Alpha', projectId: project, deadline: '2026-09-10', assigneeUserIds: ['usr_asha'], priority: 'LOW' });
    const b = await createTask({ title: 'Beta', projectId: project, deadline: '2026-09-30', assigneeUserIds: ['usr_bala'], priority: 'HIGH', tags: ['print'] });
    const c = await createTask({ title: 'Gamma', status: 'DRAFT', linkedKind: 'ORDER', linkedId: 'ord_1' });
    await post(`/tasks/${b.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${c.id}/status`, { status: 'ARCHIVED' });

    const all = await get('/tasks');
    expect(all.body.data.total).toBe(2);
    expect(all.body.data.counts).toEqual({ DRAFT: 0, TODO: 1, IN_PROGRESS: 1, PENDING_REVIEW: 0, VERIFIED: 0, BLOCKED: 0, ARCHIVED: 1 });
    expect(all.body.data.items.map((t: { title: string }) => t.title)).toEqual(['Alpha', 'Beta']);
    expect(all.body.data.items[0]).toMatchObject({ displayId: 'TSK-0001', overdue: true, project: { id: project, name: 'Ops Q4', kind: 'DEPARTMENT' }, assignees: [expect.objectContaining({ name: 'Asha Rao' })], openIssues: 0, childCount: 0 });

    expect((await get('/tasks?status=IN_PROGRESS,ARCHIVED')).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Beta', 'Gamma']);
    expect((await get('/tasks?status=IN_PROGRESS')).body.data.counts.TODO).toBe(1);
    expect((await get('/tasks?overdue=true')).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Alpha']);
    expect((await get('/tasks?assigneeUserId=usr_bala')).body.data.total).toBe(1);
    expect((await get('/tasks?q=tsk-0002')).body.data.items[0].title).toBe('Beta');
    expect((await get('/tasks?tag=print')).body.data.total).toBe(1);
    expect((await get('/tasks?priority=HIGH')).body.data.total).toBe(1);
    expect((await get('/tasks?linkedKind=ORDER&linkedId=ord_1&status=ARCHIVED')).body.data.total).toBe(1);
    expect((await get('/tasks?dueFrom=2026-09-20&dueTo=2026-09-30')).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Beta']);
    expect((await get('/tasks?sort=PRIORITY')).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Beta', 'Alpha']);
    expect((await get('/tasks?sort=DEADLINE&dir=desc')).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Beta', 'Alpha']);
    expect((await get(`/tasks?projectId=${project}&status=TODO`)).body.data.total).toBe(1);
    expect((await get('/tasks?status=NOPE')).status).toBe(400);
    expect((await get(`/tasks?a=1`)).status).toBe(200);
    expect(a.displayId).toBe('TSK-0001');
  });

  it('patches with a diff; progress on a parent is derived (409); a draft deletes, anything else archives', async () => {
    const parent = await createTask({});
    const child = await createTask({ title: 'Sub', parentTaskId: parent.id });
    expect((await patch(`/tasks/${parent.id}`, { progress: 40 })).status).toBe(409);
    const res = await patch(`/tasks/${child.id}`, { progress: 40, title: 'Sub (renamed)', deadline: '2026-10-01', linkedKind: 'ORDER', linkedId: 'ord_1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ progress: 40, title: 'Sub (renamed)', linked: { kind: 'ORDER', id: 'ord_1', label: 'Diwali push' } });
    expect(audited('WORK_TASK_UPDATED')[0]![2]).toMatchObject({ diff: expect.objectContaining({ progress: { before: 0, after: 40 }, title: { before: 'Sub', after: 'Sub (renamed)' } }) });
    expect((await get(`/tasks/${parent.id}`)).body.data.progress).toBe(40);
    expect((await patch(`/tasks/${child.id}`, {})).status).toBe(400);
    expect((await patch(`/tasks/${child.id}`, { linkedKind: 'ORDER', linkedId: 'ord_9' })).status).toBe(404);

    const draft = await createTask({ title: 'Draft', status: 'DRAFT' });
    expect((await del(`/tasks/${draft.id}`)).status).toBe(204);
    expect(await repo.findTask(draft.id)).toBeNull();
    expect(audited('WORK_TASK_DELETED')).toHaveLength(1);
    const archived = await del(`/tasks/${child.id}`);
    expect(archived.status).toBe(200);
    expect(archived.body.data).toEqual({ archived: true });
    expect((await repo.findTask(child.id))!.status).toBe('ARCHIVED');
    expect((await del('/tasks/tsk_nope')).status).toBe(404);
  });
});

/* ── the status rules ─────────────────────────────────────────────── */

describe('the status rules', () => {
  it('DRAFT → TODO → IN_PROGRESS stamps the actual start, each move audited with its diff', async () => {
    const task = await createTask({ status: 'DRAFT' });
    expect((await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(409);
    expect((await post(`/tasks/${task.id}/status`, { status: 'TODO' })).body.data.status).toBe('TODO');
    const started = await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    expect(started.body.data).toMatchObject({ status: 'IN_PROGRESS', actualStartDate: NOW.toISOString() });
    const rows = audited('WORK_TASK_STATUS_CHANGED');
    expect(rows).toHaveLength(2);
    expect(rows[1]![2]).toMatchObject({
      module: 'work',
      targetType: 'WorkTask',
      targetId: task.id,
      diff: { status: { before: 'TODO', after: 'IN_PROGRESS' }, actualStartDate: { before: null, after: NOW.toISOString() } },
      metadata: expect.objectContaining({ from: 'TODO', to: 'IN_PROGRESS', via: 'status' }),
    });
  });

  it('refuses to start while a prerequisite is unfinished, listing it; VERIFIED and ARCHIVED count as finished', async () => {
    const first = await createTask({ title: 'Print' });
    const second = await createTask({ title: 'Install', prerequisiteIds: [first.id] });
    const res = await post(`/tasks/${second.id}/status`, { status: 'IN_PROGRESS' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.prerequisites).toEqual([{ id: first.id, displayId: 'TSK-0001', title: 'Print', status: 'TODO' }]);
    await post(`/tasks/${first.id}/status`, { status: 'ARCHIVED' });
    expect((await post(`/tasks/${second.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
  });

  it('the prerequisite rule holds on the way back from BLOCKED too — TODO → BLOCKED → IN_PROGRESS is no side door', async () => {
    const first = await createTask({ title: 'Print' });
    const second = await createTask({ title: 'Install', prerequisiteIds: [first.id] });
    expect((await post(`/tasks/${second.id}/status`, { status: 'BLOCKED', reason: 'waiting on the print' })).body.data.status).toBe('BLOCKED');
    const res = await post(`/tasks/${second.id}/status`, { status: 'IN_PROGRESS' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.prerequisites).toEqual([{ id: first.id, displayId: 'TSK-0001', title: 'Print', status: 'TODO' }]);
    expect((await repo.findTask(second.id))!.status).toBe('BLOCKED');
    // A reviewer's REJECT still lands the task back in IN_PROGRESS: it had started, the door is the review's.
    expect((await post(`/tasks/${second.id}/status`, { status: 'TODO' })).status).toBe(200);
    await post(`/tasks/${first.id}/status`, { status: 'ARCHIVED' });
    expect((await post(`/tasks/${second.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
  });

  it('a task with no reviewers goes straight to VERIFIED on completion — completedAt and progress 100', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_asha'] });
    await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    const res = await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    expect(res.body.data).toMatchObject({ status: 'VERIFIED', progress: 100, completedAt: NOW.toISOString() });
    expect(audited('WORK_TASK_STATUS_CHANGED')[1]![2]).toMatchObject({ metadata: expect.objectContaining({ requested: 'PENDING_REVIEW', to: 'VERIFIED' }) });
    expect(notified('WORK_REVIEW_REQUESTED')).toEqual([]);
    expect((await post(`/tasks/${task.id}/status`, { status: 'TODO' })).status).toBe(409);
    expect((await post(`/tasks/${task.id}/status`, { status: 'ARCHIVED' })).status).toBe(200);
  });

  it('with reviewers, PENDING_REVIEW tells them, and VERIFIED comes only through the review — or work.approve', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_asha'], reviewers: [{ userId: 'usr_bala', approver: true }, { userId: 'usr_chitra' }] });
    await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    const res = await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    expect(res.body.data.status).toBe('PENDING_REVIEW');
    expect(notified('WORK_REVIEW_REQUESTED')).toEqual(['usr_bala', 'usr_chitra']);
    expect((await post(`/tasks/${task.id}/status`, { status: 'VERIFIED' }, editor)).status).toBe(409);
    expect((await post(`/tasks/${task.id}/status`, { status: 'VERIFIED' }, approver)).body.data.status).toBe('VERIFIED');
  });

  it('BLOCKED needs a reason, keeps it, and clears it on the way out', async () => {
    const task = await createTask({});
    expect((await post(`/tasks/${task.id}/status`, { status: 'BLOCKED' })).status).toBe(400);
    const blocked = await post(`/tasks/${task.id}/status`, { status: 'BLOCKED', reason: 'Waiting on the vendor' });
    expect(blocked.body.data).toMatchObject({ status: 'BLOCKED', blockedReason: 'Waiting on the vendor' });
    const back = await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    expect(back.body.data).toMatchObject({ status: 'IN_PROGRESS', blockedReason: null });
    expect((await post(`/tasks/${task.id}/status`, { status: 'DRAFT' })).status).toBe(400);
  });

  it('rolls a parent’s progress up as the mean of its children, and offers VERIFIED when all are', async () => {
    const parent = await createTask({ title: 'Parent' });
    const a = await createTask({ title: 'A', parentTaskId: parent.id });
    const b = await createTask({ title: 'B', parentTaskId: parent.id });
    await post(`/tasks/${a.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${a.id}/status`, { status: 'PENDING_REVIEW' });
    let detail = await get(`/tasks/${parent.id}`);
    expect(detail.body.data).toMatchObject({ progress: 50, childrenAllVerified: false, status: 'TODO' });
    await patch(`/tasks/${b.id}`, { progress: 30 });
    expect((await get(`/tasks/${parent.id}`)).body.data.progress).toBe(65);
    await post(`/tasks/${b.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${b.id}/status`, { status: 'PENDING_REVIEW' });
    detail = await get(`/tasks/${parent.id}`);
    expect(detail.body.data).toMatchObject({ progress: 100, childrenAllVerified: true, status: 'TODO' });
  });
});

/* ── the review ───────────────────────────────────────────────────── */

describe('the review', () => {
  async function underReview(reviewers: { userId: string; approver?: boolean }[]) {
    const task = await createTask({ assigneeUserIds: ['usr_asha'], reviewers });
    await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    return task;
  }

  it('verifies once every approver has approved; a non-approver’s mark alone does not', async () => {
    const task = await underReview([{ userId: 'usr_bala', approver: true }, { userId: 'usr_admin', approver: true }, { userId: 'usr_chitra' }]);
    expect((await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, chitra)).status).toBe(403);
    const chitraOk = await post(`/me/tasks/${task.id}/review`, { decision: 'APPROVE', note: 'Looks fine' }, chitra);
    expect(chitraOk.body.data.status).toBe('PENDING_REVIEW');
    const one = await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, editor);
    expect(one.body.data.status).toBe('PENDING_REVIEW');
    expect(one.body.data.reviewers.find((r: { userId: string }) => r.userId === 'usr_admin')).toMatchObject({ approvedAt: NOW.toISOString() });
    const two = await post(`/me/tasks/${task.id}/review`, { decision: 'APPROVE' }, tokenFor(['ADMIN'], 'usr_bala'));
    expect(two.body.data).toMatchObject({ status: 'VERIFIED', progress: 100 });
    expect(audited('WORK_TASK_REVIEWED')).toHaveLength(3);
    expect(audited('WORK_TASK_STATUS_CHANGED').slice(-1)[0]![2]).toMatchObject({ metadata: expect.objectContaining({ via: 'review', to: 'VERIFIED' }) });
  });

  it('with no approver rows, any reviewer’s approve verifies', async () => {
    const task = await underReview([{ userId: 'usr_bala' }, { userId: 'usr_chitra' }]);
    const res = await post(`/me/tasks/${task.id}/review`, { decision: 'APPROVE' }, chitra);
    expect(res.body.data.status).toBe('VERIFIED');
  });

  it('a non-reviewer is 404, unless they hold work.approve — then their approve verifies', async () => {
    const task = await underReview([{ userId: 'usr_bala', approver: true }]);
    expect((await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, editor)).status).toBe(404);
    expect((await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, approver)).body.data.status).toBe('VERIFIED');
  });

  it('REJECT sends the task back to IN_PROGRESS, files the note as a comment, and tells the assignees', async () => {
    const task = await underReview([{ userId: 'usr_bala', approver: true }]);
    const res = await post(`/me/tasks/${task.id}/review`, { decision: 'REJECT', note: 'Face 7 is missing' }, tokenFor(['ADMIN'], 'usr_bala'));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.comments).toEqual([expect.objectContaining({ author: expect.objectContaining({ userId: 'usr_bala' }), body: 'Face 7 is missing' })]);
    expect(res.body.data.reviewers[0]).toMatchObject({ rejectedAt: NOW.toISOString(), note: 'Face 7 is missing' });
    expect(notified('WORK_REJECTED')).toEqual(['usr_asha']);
    // Back under review: the old marks are cleared for the new round.
    await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    expect((await get(`/tasks/${task.id}`)).body.data.reviewers[0]).toMatchObject({ approvedAt: null, rejectedAt: null, note: null });
    expect((await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, approver)).body.data.status).toBe('VERIFIED');
    expect((await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, approver)).status).toBe(409);
  });
});

/* ── people on a task, prerequisites ──────────────────────────────── */

describe('assignees, reviewers, prerequisites', () => {
  it('replaces the assignees, audited, telling only the newcomers', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_asha'] });
    notifications.notify.mockClear();
    const res = await put(`/tasks/${task.id}/assignees`, { userIds: ['usr_asha', 'usr_chitra'] });
    expect(res.status).toBe(200);
    expect(res.body.data.assignees.map((a: { userId: string }) => a.userId)).toEqual(['usr_asha', 'usr_chitra']);
    expect(notified('WORK_ASSIGNED')).toEqual(['usr_chitra']);
    expect(audited('WORK_TASK_ASSIGNEES_SET')[0]![2]).toMatchObject({ diff: { assignees: { before: ['usr_asha'], after: ['usr_asha', 'usr_chitra'] } } });
    expect((await put(`/tasks/${task.id}/assignees`, { userIds: ['usr_left'] })).status).toBe(422);
  });

  it('replaces the reviewers, keeping a staying reviewer’s mark, and tells a newcomer while under review', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_asha'], reviewers: [{ userId: 'usr_bala', approver: true }] });
    await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    notifications.notify.mockClear();
    const res = await put(`/tasks/${task.id}/reviewers`, { reviewers: [{ userId: 'usr_bala', approver: false }, { userId: 'usr_chitra', approver: true }] });
    expect(res.body.data.reviewers).toEqual([expect.objectContaining({ userId: 'usr_bala', approver: false }), expect.objectContaining({ userId: 'usr_chitra', approver: true })]);
    expect(notified('WORK_REVIEW_REQUESTED')).toEqual(['usr_chitra']);
    expect(audited('WORK_TASK_REVIEWERS_SET')).toHaveLength(1);
  });

  it('sets prerequisites, refusing self and any cycle, naming the path', async () => {
    const a = await createTask({ title: 'A' });
    const b = await createTask({ title: 'B' });
    const c = await createTask({ title: 'C' });
    expect((await put(`/tasks/${a.id}/prerequisites`, { ids: [a.id] })).status).toBe(409);
    expect((await put(`/tasks/${b.id}/prerequisites`, { ids: [a.id] })).status).toBe(200);
    expect((await put(`/tasks/${c.id}/prerequisites`, { ids: [b.id] })).status).toBe(200);
    const cycle = await put(`/tasks/${a.id}/prerequisites`, { ids: [c.id] });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.details.cycle).toEqual([a.id, c.id, b.id, a.id]);
    expect((await put(`/tasks/${a.id}/prerequisites`, { ids: ['tsk_nope'] })).status).toBe(404);
    const detail = await get(`/tasks/${a.id}`);
    expect(detail.body.data.dependents).toEqual([expect.objectContaining({ id: b.id })]);
    expect((await get(`/tasks/${c.id}`)).body.data.prerequisites).toEqual([{ id: b.id, displayId: 'TSK-0002', title: 'B', status: 'TODO' }]);
  });
});

/* ── comments and hours ───────────────────────────────────────────── */

describe('comments and time', () => {
  it('a comment reaches the task’s people minus the author', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_asha', 'usr_chitra'], reviewers: [{ userId: 'usr_bala' }] });
    notifications.notify.mockClear();
    const res = await post(`/me/tasks/${task.id}/comments`, { body: 'Started on the east side' }, chitra);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ author: { userId: 'usr_chitra', name: 'Chitra Nair' }, body: 'Started on the east side' });
    expect(notified('WORK_COMMENT').sort()).toEqual(['usr_admin', 'usr_asha', 'usr_bala']);
    for (const call of notifyCalls()) expect(call[3]).toMatchObject({ type: 'WORK', inApp: expect.objectContaining({ type: 'WORK', relatedType: 'WORK', relatedId: task.id }) });
    expect(audited('WORK_TASK_COMMENTED')).toHaveLength(0);
    await post(`/tasks/${task.id}/comments`, { body: 'Noted' });
    expect(audited('WORK_TASK_COMMENTED')).toHaveLength(1);
    expect((await get(`/tasks/${task.id}`)).body.data.comments).toHaveLength(2);
  });

  it('hours are an assignee’s own — or anyone’s with work.edit — and only the owner or work.edit removes them', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_chitra'] });
    const view = signAccessToken('usr_asha', ['ADMIN'], undefined, { perms: ['work.view'] });
    expect((await post(`/tasks/${task.id}/time-logs`, { forDate: '2026-09-14', hours: 2 }, view)).status).toBe(403);
    expect((await post(`/me/tasks/${task.id}/time-logs`, { forDate: '2026-09-14', hours: 30 }, chitra)).status).toBe(400);
    const mine = await post(`/me/tasks/${task.id}/time-logs`, { forDate: '2026-09-14', hours: 2.5, billable: true }, chitra);
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ person: { userId: 'usr_chitra' }, forDate: '2026-09-14', hours: 2.5, billable: true });
    const desk = await post(`/tasks/${task.id}/time-logs`, { forDate: '2026-09-15', hours: 1 }, editor);
    expect(desk.status).toBe(201);
    expect(desk.body.data.person.userId).toBe('usr_admin');
    expect(audited('WORK_TIME_LOGGED')).toHaveLength(1);

    const detail = await get(`/tasks/${task.id}`);
    expect(detail.body.data.timeLogs.totals).toEqual({ hours: 3.5, billableHours: 2.5 });

    expect((await del(`/tasks/${task.id}/time-logs/${desk.body.data.id}`, view)).status).toBe(403);
    expect((await del(`/tasks/${task.id}/time-logs/${desk.body.data.id}`, editor)).status).toBe(204);
    expect((await del(`/tasks/${task.id}/time-logs/${mine.body.data.id}`, editor)).status).toBe(204);
    expect((await del(`/tasks/${task.id}/time-logs/log_nope`, editor)).status).toBe(404);
  });

  it('GET /time-logs is a person’s week with totals', async () => {
    const project = (await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' })).body.data.id;
    const task = await createTask({ projectId: project, assigneeUserIds: ['usr_asha'] });
    const other = await createTask({ title: 'Other', assigneeUserIds: ['usr_asha'] });
    await post(`/me/tasks/${task.id}/time-logs`, { forDate: '2026-09-14', hours: 2, billable: true }, asha);
    await post(`/me/tasks/${other.id}/time-logs`, { forDate: '2026-09-16', hours: 3 }, asha);
    await post(`/me/tasks/${task.id}/time-logs`, { forDate: '2026-09-22', hours: 1 }, asha);
    const week = await get('/time-logs?userId=usr_asha&from=2026-09-14&to=2026-09-20');
    expect(week.body.data.totals).toEqual({ hours: 5, billableHours: 2 });
    expect(week.body.data.items).toHaveLength(2);
    expect(week.body.data.items[0]).toMatchObject({ task: { id: other.id, displayId: 'TSK-0002' }, person: { name: 'Asha Rao' } });
    expect((await get(`/time-logs?projectId=${project}`)).body.data.totals.hours).toBe(3);
    expect((await get('/time-logs?from=2026-09-20&to=2026-09-14')).status).toBe(400);
  });
});

/* ── issues ───────────────────────────────────────────────────────── */

describe('issues', () => {
  it('mints ISS-, takes the task’s project, lists with counts, resolves and reopens — audited', async () => {
    const project = (await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' })).body.data.id;
    const task = await createTask({ projectId: project });
    const res = await post('/issues', { title: 'Permit lapsed', taskId: task.id, severity: 'CRITICAL', assigneeId: 'usr_asha' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ displayId: 'ISS-0001', projectId: project, taskId: task.id, status: 'OPEN', assignee: { name: 'Asha Rao' }, raisedBy: { userId: 'usr_admin' }, task: { id: task.id, displayId: 'TSK-0001' } });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('ISSUE');
    await post('/issues', { title: 'Minor', projectId: project, severity: 'LOW' });
    expect((await post('/issues', { title: 'X', taskId: 'tsk_nope' })).status).toBe(404);
    expect((await post('/issues', { title: 'X', assigneeId: 'usr_ghost' })).status).toBe(422);

    // The OPEN CRITICAL issue flags the task on read — no status change.
    expect((await get(`/tasks/${task.id}`)).body.data).toMatchObject({ blockedByIssue: true, status: 'TODO' });
    expect((await get('/tasks')).body.data.items[0].openIssues).toBe(1);

    const list = await get(`/issues?projectId=${project}&sort=severity`);
    expect(list.body.data).toMatchObject({ total: 2, counts: { OPEN: 2, IN_PROGRESS: 0, RESOLVED: 0, WONT_FIX: 0 } });
    expect(list.body.data.items.map((i: { severity: string }) => i.severity)).toEqual(['CRITICAL', 'LOW']);
    expect((await get('/issues?severity=LOW')).body.data.total).toBe(1);
    expect((await get('/issues?q=permit')).body.data.total).toBe(1);

    const id = res.body.data.id as string;
    expect((await patch(`/issues/${id}`, { status: 'IN_PROGRESS', assigneeId: 'usr_bala' })).body.data).toMatchObject({ status: 'IN_PROGRESS', assignee: { userId: 'usr_bala' } });
    expect((await get(`/tasks/${task.id}`)).body.data.blockedByIssue).toBe(false);
    expect((await post(`/issues/${id}/resolve`, { status: 'RESOLVED' })).status).toBe(400);
    const resolved = await post(`/issues/${id}/resolve`, { status: 'RESOLVED', resolution: 'Permit renewed' });
    expect(resolved.body.data).toMatchObject({ status: 'RESOLVED', resolution: 'Permit renewed', resolvedAt: NOW.toISOString() });
    expect(audited('WORK_ISSUE_RESOLVED')[0]![2]).toMatchObject({ targetType: 'WorkIssue', targetId: id, diff: expect.objectContaining({ status: { before: 'IN_PROGRESS', after: 'RESOLVED' } }) });
    expect((await post(`/issues/${id}/resolve`, { status: 'WONT_FIX', resolution: 'x' })).status).toBe(409);
    expect((await patch(`/issues/${id}`, { status: 'OPEN' })).status).toBe(409);
    expect((await post(`/issues/${id}/reopen`, {})).body.data).toMatchObject({ status: 'OPEN', resolution: null, resolvedAt: null });
    expect((await post(`/issues/${id}/reopen`, {})).status).toBe(409);
    const read = await get(`/issues/${id}`);
    expect(read.body.data.displayId).toBe('ISS-0001');
    // The read shape, pinned: every key the console reads, and no other.
    expect(Object.keys(read.body.data).sort()).toEqual(
      ['assignee', 'assigneeId', 'createdAt', 'description', 'displayId', 'id', 'projectId', 'raisedBy', 'raisedById', 'resolution', 'resolvedAt', 'severity', 'status', 'task', 'taskId', 'title', 'updatedAt'].sort(),
    );
    expect(read.body.data).toMatchObject({ raisedBy: { userId: 'usr_admin', name: 'Ops Admin' }, assignee: { userId: 'usr_bala', name: 'Bala Iyer' }, task: { id: task.id, displayId: 'TSK-0001', title: 'Audit the Indiranagar hoardings' } });
    expect((await get('/issues/iss_nope')).status).toBe(404);
  });
});

/* ── overview and board ───────────────────────────────────────────── */

describe('the overview', () => {
  it('does the maths on a fixture', async () => {
    const project = (await post('/projects', { name: 'Ops Q4', kind: 'DEPARTMENT', departmentId: 'dep_ops', ownerUserId: 'usr_asha' })).body.data.id;
    const late = await createTask({ title: 'Late', projectId: project, deadline: '2026-09-10', assigneeUserIds: ['usr_asha'], priority: 'HIGH' });
    const soon = await createTask({ title: 'Soon', projectId: project, deadline: '2026-09-18', assigneeUserIds: ['usr_asha', 'usr_bala'] });
    const done = await createTask({ title: 'Done', projectId: project, deadline: '2026-09-12', assigneeUserIds: ['usr_bala'] });
    await createTask({ title: 'October', projectId: project, deadline: '2026-10-05', assigneeUserIds: ['usr_chitra'], priority: 'LOW' });
    const archived = await createTask({ title: 'Gone', projectId: project, deadline: '2026-09-01' });
    await post(`/tasks/${archived.id}/status`, { status: 'ARCHIVED' });
    await post(`/tasks/${soon.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${done.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${done.id}/status`, { status: 'PENDING_REVIEW' });
    await post(`/me/tasks/${late.id}/time-logs`, { forDate: '2026-09-14', hours: 4 }, asha);
    await post(`/me/tasks/${done.id}/time-logs`, { forDate: '2026-08-30', hours: 9 }, tokenFor(['ADMIN'], 'usr_bala'));
    await post('/issues', { title: 'Permit', taskId: late.id, severity: 'CRITICAL' });
    await post('/issues', { title: 'Old', projectId: project, severity: 'LOW' });

    const res = await get(`/overview?projectId=${project}&from=2026-09-01&to=2026-10-31`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.window).toEqual({ from: '2026-09-01', to: '2026-10-31' });
    expect(data.tasks).toEqual({
      total: 4,
      byStatus: { DRAFT: 0, TODO: 2, IN_PROGRESS: 1, PENDING_REVIEW: 0, VERIFIED: 1, BLOCKED: 0, ARCHIVED: 0 },
      byPriority: { HIGH: 1, MEDIUM: 2, LOW: 1 },
      overdue: 1,
      dueThisWeek: 1,
      verifiedInWindow: 1,
    });
    expect(data.trend).toEqual([
      { month: '2026-09', planned: 3, completed: 1 },
      { month: '2026-10', planned: 1, completed: 0 },
    ]);
    expect(data.issues).toEqual({ open: 2, bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 1 }, byStatus: { OPEN: 2, IN_PROGRESS: 0, RESOLVED: 0, WONT_FIX: 0 } });
    expect(data.workload).toEqual([
      { person: expect.objectContaining({ userId: 'usr_asha' }), open: 2, inProgress: 1, overdue: 1, hoursInWindow: 4 },
      { person: expect.objectContaining({ userId: 'usr_bala' }), open: 1, inProgress: 1, overdue: 0, hoursInWindow: 0 },
      { person: expect.objectContaining({ userId: 'usr_chitra' }), open: 1, inProgress: 0, overdue: 0, hoursInWindow: 0 },
    ]);
    expect(data.overdueList).toEqual([{ id: late.id, displayId: 'TSK-0001', title: 'Late', deadline: '2026-09-10T18:29:59.999Z', assignees: [expect.objectContaining({ userId: 'usr_asha' })] }]);
    expect(data.projects).toEqual([{ id: project, displayId: 'PRJ-0001', name: 'Ops Q4', kind: 'DEPARTMENT', open: 3, verified: 1, progress: 25 }]);
    // Without a window: this Indian month.
    expect((await get('/overview')).body.data.window).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('the board', () => {
  it('draws every status but ARCHIVED, newest-updated first, capped at 100 with the rest counted', async () => {
    for (let i = 0; i < 103; i += 1) await createTask({ title: `T${i}`, assigneeUserIds: i % 2 === 0 ? ['usr_asha'] : [] });
    const blocked = await createTask({ title: 'Blocked one' });
    await post(`/tasks/${blocked.id}/status`, { status: 'BLOCKED', reason: 'vendor' });
    const res = await get('/board');
    expect(res.status).toBe(200);
    expect(res.body.data.columns.map((c: { status: string }) => c.status)).toEqual(['DRAFT', 'TODO', 'IN_PROGRESS', 'PENDING_REVIEW', 'VERIFIED', 'BLOCKED']);
    const todo = res.body.data.columns[1];
    expect(todo).toMatchObject({ count: 103, more: 3 });
    expect(todo.tasks).toHaveLength(100);
    expect(todo.tasks[0]).toMatchObject({ title: 'T102', assignees: [expect.objectContaining({ name: 'Asha Rao' })] });
    expect(res.body.data.columns[5]).toMatchObject({ count: 1, more: 0, tasks: [expect.objectContaining({ title: 'Blocked one' })] });
    expect((await get('/board?assigneeUserId=usr_asha')).body.data.columns[1].count).toBe(52);
  });
});

/* ── me ───────────────────────────────────────────────────────────── */

describe('/me', () => {
  it('lists the caller’s own open tasks, overdue first, and 404s another person’s task', async () => {
    const late = await createTask({ title: 'Late', deadline: '2026-09-10', assigneeUserIds: ['usr_chitra'] });
    const soon = await createTask({ title: 'Soon', deadline: '2026-09-15', assigneeUserIds: ['usr_chitra'] });
    const theirs = await createTask({ title: 'Theirs', assigneeUserIds: ['usr_asha'] });
    const reviewing = await createTask({ title: 'Reviewing', assigneeUserIds: ['usr_asha'], reviewers: [{ userId: 'usr_chitra' }] });
    await post(`/tasks/${reviewing.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${reviewing.id}/status`, { status: 'PENDING_REVIEW' });

    const list = await get('/me/tasks', chitra);
    expect(list.body.data.items.map((t: { title: string; overdue: boolean }) => [t.title, t.overdue])).toEqual([
      ['Late', true],
      ['Soon', false],
    ]);
    expect((await get('/me/tasks?status=TODO', chitra)).body.data.total).toBe(2);
    expect((await get(`/me/tasks/${late.id}`, chitra)).body.data.displayId).toBe('TSK-0001');
    expect((await get(`/me/tasks/${reviewing.id}`, chitra)).status).toBe(200);
    expect((await get(`/me/tasks/${theirs.id}`, chitra)).status).toBe(404);
    expect((await get('/me/tasks/tsk_nope', chitra)).status).toBe(404);
    expect((await get('/me/summary', chitra)).body.data).toEqual({ open: 2, dueToday: 1, overdue: 1, awaitingMyReview: 1 });
    expect(soon.status).toBe('TODO');
  });

  it('?reviewing=true lists the tasks awaiting the caller’s mark, deadline-sorted, and the summary counts the same list', async () => {
    const first = await createTask({ title: 'First', deadline: '2026-09-20', assigneeUserIds: ['usr_asha'], reviewers: [{ userId: 'usr_chitra' }, { userId: 'usr_bala', approver: true }] });
    const second = await createTask({ title: 'Second', deadline: '2026-09-18', assigneeUserIds: ['usr_asha'], reviewers: [{ userId: 'usr_chitra' }] });
    const notYet = await createTask({ title: 'Not yet', assigneeUserIds: ['usr_asha'], reviewers: [{ userId: 'usr_chitra' }] });
    const assignedOnly = await createTask({ title: 'Assigned only', assigneeUserIds: ['usr_chitra'], reviewers: [{ userId: 'usr_bala' }] });
    for (const t of [first, second, assignedOnly]) {
      await post(`/tasks/${t.id}/status`, { status: 'IN_PROGRESS' });
      await post(`/tasks/${t.id}/status`, { status: 'PENDING_REVIEW' });
    }
    // A reviewer sees only the PENDING_REVIEW tasks that lack their mark, nearest deadline first.
    const list = await get('/me/tasks?reviewing=true', chitra);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((t: { title: string }) => t.title)).toEqual(['Second', 'First']);
    expect(list.body.data.total).toBe(2);
    expect((await get('/me/summary', chitra)).body.data.awaitingMyReview).toBe(2);
    // The assignee-only caller sees nothing under the flag — and the flag does not touch the assigned list.
    expect((await get('/me/tasks?reviewing=true', asha)).body.data.items).toEqual([]);
    expect((await get('/me/tasks', chitra)).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Assigned only']);
    expect((await get('/me/tasks?reviewing=false', chitra)).body.data.total).toBe(1);
    // Once the caller has marked a task it drops out, even while the task stays under review for the approver.
    await post(`/me/tasks/${first.id}/review`, { decision: 'APPROVE' }, chitra);
    expect((await get(`/tasks/${first.id}`)).body.data.status).toBe('PENDING_REVIEW');
    expect((await get('/me/tasks?reviewing=true', chitra)).body.data.items.map((t: { title: string }) => t.title)).toEqual(['Second']);
    expect((await get('/me/summary', chitra)).body.data.awaitingMyReview).toBe(1);
    // A rejection sends the task back to IN_PROGRESS, so it leaves the list too.
    await post(`/me/tasks/${second.id}/review`, { decision: 'REJECT', note: 'Redo the east side' }, chitra);
    expect((await get('/me/tasks?reviewing=true', chitra)).body.data.total).toBe(0);
    expect((await get('/me/summary', chitra)).body.data.awaitingMyReview).toBe(0);
    expect(notYet.status).toBe('TODO');
  });

  it('lets an assignee start, block with a reason and submit — never archive or verify', async () => {
    const task = await createTask({ assigneeUserIds: ['usr_chitra'], reviewers: [{ userId: 'usr_asha', approver: true }] });
    const theirs = await createTask({ title: 'Theirs', assigneeUserIds: ['usr_asha'] });
    expect((await post(`/me/tasks/${theirs.id}/status`, { status: 'IN_PROGRESS' }, chitra)).status).toBe(404);
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'ARCHIVED' }, chitra)).status).toBe(400);
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'VERIFIED' }, chitra)).status).toBe(400);
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'BLOCKED' }, chitra)).status).toBe(400);
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'IN_PROGRESS' }, chitra)).body.data.status).toBe('IN_PROGRESS');
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'BLOCKED', reason: 'No access' }, chitra)).body.data.blockedReason).toBe('No access');
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'IN_PROGRESS' }, chitra)).body.data.status).toBe('IN_PROGRESS');
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' }, chitra)).body.data.status).toBe('PENDING_REVIEW');
    expect(notified('WORK_REVIEW_REQUESTED')).toEqual(['usr_asha']);
    expect(notifyCalls().find((call) => call[0] === 'WORK_REVIEW_REQUESTED')![3]).toMatchObject({ type: 'WORK', inApp: expect.objectContaining({ type: 'WORK', relatedType: 'WORK', relatedId: task.id }) });
    // A reviewer who is not an assignee reviews but does not move the task.
    expect((await post(`/me/tasks/${task.id}/status`, { status: 'IN_PROGRESS' }, asha)).status).toBe(403);
    expect((await post(`/me/tasks/${task.id}/time-logs`, { forDate: '2026-09-15', hours: 1 }, asha)).status).toBe(403);
    expect((await post(`/me/tasks/${task.id}/review`, { decision: 'APPROVE' }, chitra)).status).toBe(404);
    expect((await post(`/me/tasks/${task.id}/review`, { decision: 'APPROVE' }, asha)).body.data.status).toBe('VERIFIED');
    // The assignee's own moves are the task's history too: audited under their id, so the trail reads whole.
    expect(audited('WORK_TASK_STATUS_CHANGED').map((call) => call[0])).toEqual(['usr_chitra', 'usr_chitra', 'usr_chitra', 'usr_chitra', 'usr_asha']);
  });
});

/* ── recurrence ───────────────────────────────────────────────────── */

describe('recurrence', () => {
  it('spawns the next TODO copy on VERIFIED — same people, dates advanced — until the count runs out', async () => {
    const task = await createTask({
      title: 'Weekly site check',
      deadline: '2026-09-18',
      startDate: '2026-09-15',
      assigneeUserIds: ['usr_chitra'],
      reviewers: [{ userId: 'usr_asha', approver: true }],
      recurrence: { frequency: 'WEEKLY', totalOccurrences: 2 },
    });
    await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    notifications.notify.mockClear();
    await post(`/tasks/${task.id}/review`, { decision: 'APPROVE' }, approver);
    expect(repo.tasks).toHaveLength(2);
    const next = repo.tasks[1]!;
    expect(next).toMatchObject({ displayId: 'TSK-0002', title: 'Weekly site check', status: 'TODO', progress: 0, deadline: new Date('2026-09-25T18:29:59.999Z'), startDate: new Date('2026-09-21T18:30:00.000Z'), recurrence: { frequency: 'WEEKLY', totalOccurrences: 2, occurrence: 2 } });
    expect(await repo.findAssignees(next.id)).toEqual([expect.objectContaining({ userId: 'usr_chitra' })]);
    expect(await repo.findReviewers(next.id)).toEqual([expect.objectContaining({ userId: 'usr_asha', approver: true })]);
    expect(notified('WORK_ASSIGNED')).toEqual(['usr_chitra']);
    expect(audited('WORK_TASK_RECURRED')).toHaveLength(1);
    // The second occurrence is the last: verifying it spawns nothing.
    await post(`/tasks/${next.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${next.id}/status`, { status: 'PENDING_REVIEW' });
    await post(`/tasks/${next.id}/review`, { decision: 'APPROVE' }, approver);
    expect(repo.tasks).toHaveLength(2);
  });

  it('stops at endDate', async () => {
    const task = await createTask({ title: 'Daily', deadline: '2026-09-16', recurrence: { frequency: 'DAILY', endDate: '2026-09-17' } });
    await post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${task.id}/status`, { status: 'PENDING_REVIEW' });
    expect(repo.tasks).toHaveLength(2);
    const next = repo.tasks[1]!;
    await post(`/tasks/${next.id}/status`, { status: 'IN_PROGRESS' });
    await post(`/tasks/${next.id}/status`, { status: 'PENDING_REVIEW' });
    expect(repo.tasks).toHaveLength(2);
  });
});
