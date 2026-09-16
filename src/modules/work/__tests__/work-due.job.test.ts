import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily due sweep — Lot AA.
 *
 * Pinned: the service tells every assignee of a task due tomorrow and of a
 * task overdue, once per task per Indian day under a Redis key (a second
 * sweep the same day tells nobody); and the job ticks only from 08:00 IST,
 * heartbeats, takes the tick lock and the day key, and releases the lock.
 */

const { redis, jobs, logging, notifications, identifiers, audit } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), del: vi.fn() } },
  jobs: { recordHeartbeat: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
  notifications: { notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: null, deliveries: [] })) },
  identifiers: { allocateIdentifier: vi.fn(async () => 'TSK-0001') },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../../shared/logging', () => logging);
vi.mock('../../../shared/errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/errors')>();
  return { ...actual, reportError: vi.fn(async () => undefined) };
});
vi.mock('../../notifications', () => notifications);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { workDueTick } from '../../../jobs/work-due.job';
import { setWorkRepository, sweepDueTasks } from '../work.service';
import { InMemoryWorkRepository } from './in-memory-work.repository';

/** 08:30 IST on 15 Sep 2026. */
const MORNING = new Date('2026-09-15T03:00:00.000Z');
/** 06:30 IST the same day. */
const EARLY = new Date('2026-09-15T01:00:00.000Z');

let repo: InMemoryWorkRepository;
const keys = new Set<string>();

type NotifyCall = [string, string, { task: string }, Record<string, unknown>];
const notifyCalls = () => notifications.notify.mock.calls as unknown as NotifyCall[];
const notified = (event: string) => notifyCalls().filter((call) => call[0] === event).map((call) => [call[1], call[2].task]);

beforeEach(async () => {
  vi.clearAllMocks();
  keys.clear();
  // SET NX over a set: the first write of a key wins, the rest are null.
  redis.redis.set.mockImplementation(async (key: string) => (keys.has(key) ? null : (keys.add(key), 'OK')));
  redis.redis.del.mockResolvedValue(1);
  repo = new InMemoryWorkRepository();
  setWorkRepository(repo);
  repo.person({ userId: 'usr_asha', name: 'Asha Rao' });
  repo.person({ userId: 'usr_bala', name: 'Bala Iyer' });
  const task = async (title: string, deadline: Date | null, status: 'TODO' | 'IN_PROGRESS' | 'VERIFIED', assignees: string[]) => {
    const row = await repo.createTask({
      displayId: `TSK-${title}`,
      projectId: null,
      parentTaskId: null,
      title,
      description: null,
      status,
      priority: 'MEDIUM',
      startDate: null,
      deadline,
      effortEstimateH: null,
      linkedKind: null,
      linkedId: null,
      recurrence: null,
      tags: [],
      createdById: 'usr_admin',
      assignedById: null,
    });
    await repo.setAssignees(row.id, assignees, MORNING);
    return row;
  };
  // Due tomorrow (16 Sep IST, end of day), overdue since the 10th, done on time, due next week.
  await task('Tomorrow', new Date('2026-09-16T18:29:59.999Z'), 'TODO', ['usr_asha', 'usr_bala']);
  await task('Late', new Date('2026-09-10T18:29:59.999Z'), 'IN_PROGRESS', ['usr_asha']);
  await task('Done', new Date('2026-09-10T18:29:59.999Z'), 'VERIFIED', ['usr_bala']);
  await task('NextWeek', new Date('2026-09-22T18:29:59.999Z'), 'TODO', ['usr_bala']);
  await task('NoDeadline', null, 'TODO', ['usr_bala']);
});

afterEach(() => {
  setWorkRepository(null);
});

describe('sweepDueTasks', () => {
  it('tells the assignees of a task due tomorrow and of an overdue task, once per task per day', async () => {
    const first = await sweepDueTasks(MORNING);
    expect(first).toEqual({ dueTomorrow: 1, overdue: 1 });
    expect(notified('WORK_DUE')).toEqual([
      ['usr_asha', 'TSK-Tomorrow · Tomorrow'],
      ['usr_bala', 'TSK-Tomorrow · Tomorrow'],
    ]);
    expect(notified('WORK_OVERDUE')).toEqual([['usr_asha', 'TSK-Late · Late']]);
    expect(notifyCalls()[0]![3]).toMatchObject({ type: 'WORK', inApp: expect.objectContaining({ type: 'WORK', relatedType: 'WORK', title: 'A task is due tomorrow' }) });
    expect(redis.redis.set).toHaveBeenCalledWith(expect.stringMatching(/^work:due:tsk_\d+:2026-09-15$/), '1', 'EX', 36 * 60 * 60, 'NX');

    notifications.notify.mockClear();
    const second = await sweepDueTasks(new Date(MORNING.getTime() + 60 * 60 * 1000));
    expect(second).toEqual({ dueTomorrow: 0, overdue: 0 });
    expect(notifications.notify).not.toHaveBeenCalled();

    // The next Indian day is a new key: the overdue task is told again, the one due "tomorrow" is now overdue.
    const nextDay = await sweepDueTasks(new Date('2026-09-17T03:00:00.000Z'));
    expect(nextDay).toEqual({ dueTomorrow: 0, overdue: 2 });
  });

  it('skips a task Redis could not mark rather than risk telling twice', async () => {
    redis.redis.set.mockRejectedValueOnce(new Error('redis down'));
    const report = await sweepDueTasks(MORNING);
    expect(report).toEqual({ dueTomorrow: 0, overdue: 1 });
    expect(logging.logger.warn).toHaveBeenCalledWith('Work due sweep could not mark a task; skipping it this tick', expect.objectContaining({ tag: 'work' }));
  });
});

describe('the work-due tick', () => {
  it('heartbeats and does nothing before 08:00 IST', async () => {
    await workDueTick(EARLY);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('work-due', EARLY);
    expect(redis.redis.set).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('from 08:00 IST takes the tick lock and the day key, sweeps once, logs, and releases the lock', async () => {
    await workDueTick(MORNING);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('work-due', MORNING);
    expect(redis.redis.set).toHaveBeenCalledWith('lock:work-due-tick', '1', 'PX', 10 * 60 * 1000, 'NX');
    expect(redis.redis.set).toHaveBeenCalledWith('lock:work-due:2026-09-15', '1', 'EX', 36 * 60 * 60, 'NX');
    expect(notifications.notify).toHaveBeenCalledTimes(3);
    expect(logging.logger.info).toHaveBeenCalledWith('Work due notices sent', expect.objectContaining({ day: '2026-09-15', dueTomorrow: 1, overdue: 1 }));
    expect(redis.redis.del).toHaveBeenCalledWith('lock:work-due-tick');

    // A later tick the same day finds the day key taken.
    notifications.notify.mockClear();
    await workDueTick(new Date(MORNING.getTime() + 15 * 60 * 1000));
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does nothing when another instance holds the lock', async () => {
    keys.add('lock:work-due-tick');
    await workDueTick(MORNING);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(redis.redis.del).not.toHaveBeenCalled();
  });
});
