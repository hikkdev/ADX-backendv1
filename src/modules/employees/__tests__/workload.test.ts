import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q120/Q139) — the workload measure.
 *
 * What is pinned: the route is ADMIN and sits ahead of /:userId; buckets are
 * whole weeks (Monday) or months covering the window; a staffer's load is
 * the weighted open items (counted once, in the bucket holding today), the
 * diary entries and the classed audit rows in the bucket, normalised to a
 * week; sign-ins are not work; the bands come from the platform settings;
 * and the share of staff in each band per bucket is what the chart draws.
 */

const { repository, settings } = vi.hoisted(() => ({
  repository: { findStaff: vi.fn(), countOpenAssigned: vi.fn(), findScheduleEntries: vi.fn(), countActions: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-workload.repository', () => ({ prismaWorkloadRepository: repository }));
vi.mock('../prisma-employees.repository', () => ({ prismaEmployeeRepository: {} }));
vi.mock('../../app-config', () => settings);
vi.mock('../../users', () => ({ userExists: vi.fn() }));
vi.mock('../../auth', () => ({ createInvite: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { employeeRouter } from '../employees.routes';
import { bucketsFor, classifyAction, istDayStart, levelFor, windowFor, workloadReport } from '../workload.service';

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
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');
/** A Wednesday, 10:00 IST. */
const NOW = new Date('2026-09-16T04:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue({ hr: { workloadThresholds: { medium: 10, high: 25 } } });
  repository.findStaff.mockResolvedValue([
    { userId: 'usr_a', employeeId: 'emp_a', name: 'Asha', designation: 'Reviewer', department: 'Trust' },
    { userId: 'usr_b', employeeId: 'emp_b', name: 'Bala', designation: 'Coordinator', department: 'Ops' },
  ]);
  repository.countOpenAssigned.mockResolvedValue([{ userId: 'usr_a', kyc: 5, tickets: 2, fraud: 1 }]);
  repository.findScheduleEntries.mockResolvedValue([
    { assigneeUserId: 'usr_b', date: new Date('2026-09-15T00:00:00.000Z') },
    { assigneeUserId: 'usr_b', date: new Date('2026-09-08T00:00:00.000Z') },
  ]);
  repository.countActions.mockResolvedValue([]);
});

describe('buckets', () => {
  it('are whole Monday weeks or calendar months covering the window', () => {
    expect(bucketsFor('2026-09-02', '2026-09-16', 'week')).toEqual([
      { start: '2026-08-31', end: '2026-09-07', days: 7 },
      { start: '2026-09-07', end: '2026-09-14', days: 7 },
      { start: '2026-09-14', end: '2026-09-21', days: 7 },
    ]);
    expect(bucketsFor('2026-08-20', '2026-09-02', 'month')).toEqual([
      { start: '2026-08-01', end: '2026-09-01', days: 31 },
      { start: '2026-09-01', end: '2026-10-01', days: 30 },
    ]);
  });

  it('default to the last twelve weeks ending today, in Indian time', () => {
    expect(windowFor({ granularity: 'week' }, NOW)).toEqual({ from: '2026-06-25', to: '2026-09-16' });
    expect(windowFor({ granularity: 'month' }, NOW)).toEqual({ from: '2026-03-18', to: '2026-09-16' });
    expect(istDayStart('2026-09-16').toISOString()).toBe('2026-09-15T18:30:00.000Z');
  });
});

describe('the measure', () => {
  it('classes audit rows and leaves sign-ins out', () => {
    expect(classifyAction('PUBLISHER_KYC_REVIEWED')).toBe('decisions');
    expect(classifyAction('REFUND_REQUEST_APPROVED')).toBe('decisions');
    expect(classifyAction('CREATIVE_REVIEWED')).toBe('decisions');
    expect(classifyAction('LISTING_SENT_BACK')).toBe('moderation');
    expect(classifyAction('REVIEW_HIDDEN')).toBe('moderation');
    expect(classifyAction('SUPPORT_TICKET_NOTE_ADDED')).toBe('replies');
    expect(classifyAction('DISPUTE_STATUS_CHANGED')).toBe('replies');
    expect(classifyAction('ORDER_OPS_OVERRIDE')).toBe('ops');
    expect(classifyAction('PUBLISHER_KYC_ASSIGNED')).toBe('ops');
    expect(classifyAction('SCHEDULE_ENTRY_CREATED')).toBe('ops');
    expect(classifyAction('geo.PATCH /cities/:id')).toBe('other');
    expect(classifyAction('LOGIN_PASSWORD')).toBeNull();
    expect(classifyAction('FILE_VIEWED')).toBeNull();
    expect(classifyAction('SMS')).toBeNull();
  });

  it('bands a load by the thresholds', () => {
    const thresholds = { medium: 10, high: 25 };
    expect(levelFor(9.99, thresholds)).toBe('LOW');
    expect(levelFor(10, thresholds)).toBe('MEDIUM');
    expect(levelFor(25, thresholds)).toBe('HIGH');
  });

  it('counts open items once in the bucket holding today, diary entries and actions in theirs, all per week', async () => {
    repository.countActions.mockImplementation(async (_ids: string[], from: Date) =>
      from.getTime() === istDayStart('2026-09-14').getTime()
        ? [
            { userId: 'usr_a', action: 'PUBLISHER_KYC_REVIEWED', count: 4 },
            { userId: 'usr_a', action: 'LOGIN_PASSWORD', count: 9 },
            { userId: 'usr_b', action: 'ORDER_OPS_OVERRIDE', count: 3 },
            { userId: 'usr_b', action: 'SUPPORT_TICKET_NOTE_ADDED', count: 2 },
          ]
        : [],
    );
    const report = await workloadReport({ from: '2026-09-02', to: '2026-09-16', granularity: 'week' }, NOW);

    expect(report.thresholds).toEqual({ medium: 10, high: 25 });
    expect(report.buckets.map((b) => b.start)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(repository.countActions).toHaveBeenCalledTimes(3);
    expect(repository.findScheduleEntries).toHaveBeenCalledWith(['usr_a', 'usr_b'], new Date('2026-08-31T00:00:00.000Z'), new Date('2026-09-21T00:00:00.000Z'));

    const asha = report.employees.find((e) => e.userId === 'usr_a')!;
    expect(asha.open).toEqual({ kyc: 5, tickets: 2, fraud: 1, total: 8 });
    // Nothing before this week: the open snapshot is not projected into the past.
    expect(asha.buckets[0]).toMatchObject({ start: '2026-08-31', open: 0, load: 0, level: 'LOW' });
    // This week: open 5×2 + 2×1 + 1×3 = 15, plus 4 decisions × 2 = 8; sign-ins ignored.
    expect(asha.buckets[2]).toMatchObject({ start: '2026-09-14', open: 8, load: 23, level: 'MEDIUM', actions: { decisions: 4, total: 4 } });

    const bala = report.employees.find((e) => e.userId === 'usr_b')!;
    // Last week: one diary entry. This week: one entry + 3 ops + 2 replies × 0.5 = 1 + 3 + 1 = 5.
    expect(bala.buckets[1]).toMatchObject({ start: '2026-09-07', schedule: 1, load: 1, level: 'LOW' });
    expect(bala.buckets[2]).toMatchObject({ start: '2026-09-14', schedule: 1, load: 5, level: 'LOW', actions: { ops: 3, replies: 2, total: 5 } });

    // The chart's series: the share of staff in each band per bucket.
    expect(report.buckets[2]).toMatchObject({ staff: 2, counts: { LOW: 1, MEDIUM: 1, HIGH: 0 }, share: { LOW: 0.5, MEDIUM: 0.5, HIGH: 0 } });
    expect(report.buckets[0]).toMatchObject({ counts: { LOW: 2, MEDIUM: 0, HIGH: 0 }, share: { LOW: 1, MEDIUM: 0, HIGH: 0 } });
  });

  it('normalises a month to a week, and lands the open snapshot in the last bucket of a window in the past', async () => {
    repository.countActions.mockResolvedValue([{ userId: 'usr_a', action: 'PUBLISHER_KYC_REVIEWED', count: 30 }]);
    repository.findScheduleEntries.mockResolvedValue([]);
    const report = await workloadReport({ from: '2026-06-01', to: '2026-06-30', granularity: 'month' }, NOW);
    expect(report.buckets).toHaveLength(1);
    const asha = report.employees[0]!;
    // 30 decisions × 2 × 7/30 = 14, plus the open snapshot 15 in the only (past) bucket.
    expect(asha.buckets[0]).toMatchObject({ start: '2026-06-01', load: 29, level: 'HIGH', open: 8 });
  });
});

describe('GET /employees/workload', () => {
  it('is ADMIN, ahead of /:userId, and refuses a window past a year or a from after to', async () => {
    expect((await request(app()).get('/api/v1/employees/workload').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    const res = await request(app()).get('/api/v1/employees/workload?from=2026-09-02&to=2026-09-16').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.granularity).toBe('week');
    expect(res.body.data.weights.open).toEqual({ kyc: 2, tickets: 1, fraud: 3 });
    expect(res.body.data.employees).toHaveLength(2);
    expect((await request(app()).get('/api/v1/employees/workload?from=2025-01-01&to=2026-09-16').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app()).get('/api/v1/employees/workload?from=2026-09-16&to=2026-09-02').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app()).get('/api/v1/employees/workload?granularity=day').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
  });
});
