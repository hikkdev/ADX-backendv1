import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily retention sweep — Lot E (decisions 95/126).
 *
 * Two lists and no destruction: the admins hear once about every erasure
 * request that has run past its thirty days, and a report row names the
 * erased people whose financial record has now outlived its retention. The
 * ledger is append-only and a human decides what to do with the report.
 */

const { lifecycle, appConfig, users, notifications } = vi.hoisted(() => ({
  lifecycle: { erasuresDue: vi.fn(), erasuresPastRetention: vi.fn(), purgeExpiredDataExports: vi.fn(async () => ({ expired: 0, deleted: 0 })) },
  appConfig: { getConfigObject: vi.fn(), saveConfigObject: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  notifications: { createNotification: vi.fn() },
}));

vi.mock('../../account-lifecycle', () => lifecycle);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);

import { retentionSweep } from '../retention.service';
import { ERASURE_DUE_KEY, RETENTION_DUE_KEY } from '../ops.keys';

const NOW = new Date('2026-09-12T02:00:00Z');

const request = (over: Record<string, unknown> = {}) => ({
  id: 'ers_1',
  userId: 'usr_1',
  requestedVia: 'APP',
  requestedAt: new Date('2026-08-01T00:00:00Z'),
  dueAt: new Date('2026-08-31T00:00:00Z'),
  status: 'PENDING',
  reason: null,
  approvedById: null,
  approvedAt: null,
  dpoName: null,
  completedAt: null,
  retainUntil: null,
  refusedReason: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle.erasuresDue.mockResolvedValue([]);
  lifecycle.erasuresPastRetention.mockResolvedValue([]);
  appConfig.getConfigObject.mockResolvedValue(null);
  appConfig.saveConfigObject.mockImplementation(async (_key: string, value: unknown) => value);
  users.listAdminUserIds.mockResolvedValue(['adm_1', 'adm_2']);
  notifications.createNotification.mockResolvedValue({});
});

describe('retentionSweep — erasure requests past due', () => {
  it('tells every admin once, and remembers that it did', async () => {
    lifecycle.erasuresDue.mockResolvedValue([request()]);

    const first = await retentionSweep(NOW);
    expect(first.erasureDue.notified).toEqual(['ers_1']);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'adm_1', type: 'SYSTEM', title: 'Erasure request past due', relatedId: 'ers_1' }),
    );
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(
      ERASURE_DUE_KEY,
      expect.objectContaining({ notified: { ers_1: NOW.toISOString() } }),
    );

    // The next day the row says it was already told; nobody hears again.
    appConfig.getConfigObject.mockImplementation(async (key: string) =>
      key === ERASURE_DUE_KEY ? { notified: { ers_1: NOW.toISOString() } } : null,
    );
    notifications.createNotification.mockClear();
    const second = await retentionSweep(new Date(NOW.getTime() + 86_400_000));
    expect(second.erasureDue.notified).toEqual([]);
    expect(second.erasureDue.outstanding).toBe(1);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('forgets a request that is no longer past due, so a re-opened one can be raised again', async () => {
    appConfig.getConfigObject.mockImplementation(async (key: string) =>
      key === ERASURE_DUE_KEY ? { notified: { ers_gone: '2026-08-01T00:00:00.000Z' } } : null,
    );
    await retentionSweep(NOW);
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(ERASURE_DUE_KEY, expect.objectContaining({ notified: {} }));
  });

  it('does not write the notification when there is no admin to tell, and does not mark it told', async () => {
    users.listAdminUserIds.mockResolvedValue([]);
    lifecycle.erasuresDue.mockResolvedValue([request()]);
    const result = await retentionSweep(NOW);
    expect(result.erasureDue.notified).toEqual([]);
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(ERASURE_DUE_KEY, expect.objectContaining({ notified: {} }));
  });
});

describe('retentionSweep — financial rows past retention', () => {
  it('writes the report row and destroys nothing', async () => {
    lifecycle.erasuresPastRetention.mockResolvedValue([
      request({
        id: 'ers_9',
        userId: 'usr_9',
        status: 'DONE',
        completedAt: new Date('2018-02-01T00:00:00Z'),
        retainUntil: new Date('2026-03-31T18:29:59.999Z'),
      }),
    ]);

    const result = await retentionSweep(NOW);
    expect(result.retentionDue.count).toBe(1);
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(RETENTION_DUE_KEY, {
      generatedAt: NOW.toISOString(),
      count: 1,
      items: [
        {
          erasureId: 'ers_9',
          userId: 'usr_9',
          completedAt: '2018-02-01T00:00:00.000Z',
          retainUntil: '2026-03-31T18:29:59.999Z',
        },
      ],
    });
    // The erasure side of the sweep is read-only. G6 (Q104): the one thing
    // it removes is an expired data export — a copy the person already has.
    expect(Object.keys(lifecycle)).toEqual(['erasuresDue', 'erasuresPastRetention', 'purgeExpiredDataExports']);
    expect(lifecycle.purgeExpiredDataExports).toHaveBeenCalledWith(NOW);
    expect(result.dataExports).toEqual({ expired: 0, deleted: 0 });
  });

  it('writes an empty report when nothing is due, so the page never shows a stale list', async () => {
    await retentionSweep(NOW);
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(
      RETENTION_DUE_KEY,
      expect.objectContaining({ count: 0, items: [] }),
    );
  });
});
