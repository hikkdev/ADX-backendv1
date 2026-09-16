import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The weekly payout draft job — Lot G (Q124).
 *
 * What is pinned: the tick heartbeats, takes the Redis lock, does nothing
 * while the cadence is off or before this week's slot has been reached, and
 * drafts once per slot as the system user; a draft tells every admin who
 * holds `finance.approve` and nobody else; no draftable line means no batch
 * and no notice; a throw is logged and the lock released.
 */

const { redis, appConfig, access, notifications, payouts, users, jobs } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), del: vi.fn(), hset: vi.fn() } },
  appConfig: { getPlatformSettings: vi.fn() },
  access: { permissionsFor: vi.fn() },
  notifications: { createNotification: vi.fn() },
  payouts: {
    draftScheduledBatch: vi.fn(),
    // The pure cadence arithmetic, real.
    lastSlot: (cadence: { weekday: number; hourIst: number }, now: Date) => {
      const IST = 5.5 * 60 * 60 * 1000;
      const shifted = new Date(now.getTime() + IST);
      const daysBack = (shifted.getUTCDay() - cadence.weekday + 7) % 7;
      const candidate = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysBack, cadence.hourIst) - IST);
      return candidate.getTime() <= now.getTime() ? candidate : new Date(candidate.getTime() - 7 * 24 * 60 * 60 * 1000);
    },
  },
  users: { listAdminUserIds: vi.fn(), systemUserId: vi.fn() },
  jobs: { recordHeartbeat: vi.fn() },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../access-control', () => access);
vi.mock('../../notifications', () => notifications);
vi.mock('../../payouts', () => payouts);
vi.mock('../../users', () => users);

import { financeAdminIds, payoutBatchDraftTick } from '../../../jobs/payout-batch-draft.job';

const MONDAY_1030 = new Date('2026-09-14T05:00:00Z');
const SLOT_KEY = 'lock:payout-batch-draft:2026-09-14T04:30:00.000Z';

const draft = () => ({
  batch: { id: 'bat_1', reference: 'BATCH-2026-000001', status: 'DRAFT' },
  lineCount: 3,
  totalNet: '4500.50',
  moreWaiting: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  redis.redis.del.mockResolvedValue(1);
  appConfig.getPlatformSettings.mockResolvedValue({ finance: { payoutBatchCadence: { enabled: true, weekday: 1, hourIst: 10 } } });
  users.systemUserId.mockResolvedValue('sys-1');
  users.listAdminUserIds.mockResolvedValue(['adm-super', 'adm-finance', 'adm-comms']);
  access.permissionsFor.mockImplementation(async (userId: string) =>
    userId === 'adm-comms' ? ['comms.view', 'comms.edit'] : userId === 'adm-finance' ? ['finance.view', 'finance.approve'] : ['finance.approve', 'comms.edit', 'users.edit'],
  );
  payouts.draftScheduledBatch.mockResolvedValue(draft());
  notifications.createNotification.mockResolvedValue({ id: 'ntf' });
});

describe('the tick', () => {
  it('heartbeats, locks, drafts once for the slot as the system user, and tells the finance admins only', async () => {
    await payoutBatchDraftTick(MONDAY_1030);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('payout-batch-draft', MONDAY_1030);
    expect(redis.redis.set).toHaveBeenNthCalledWith(1, 'lock:payout-batch-draft-tick', '1', 'PX', 4 * 60 * 1000, 'NX');
    expect(redis.redis.set).toHaveBeenNthCalledWith(2, SLOT_KEY, '1', 'EX', 8 * 24 * 60 * 60, 'NX');
    expect(payouts.draftScheduledBatch).toHaveBeenCalledWith('sys-1', MONDAY_1030);
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    const told = notifications.createNotification.mock.calls.map((c) => (c[0] as { userId: string }).userId).sort();
    expect(told).toEqual(['adm-finance', 'adm-super']);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'adm-finance', type: 'PAYOUT', title: 'Weekly payout batch drafted', relatedId: 'bat_1', subtitle: 'BATCH-2026-000001 · 3 lines · ₹4500.50' }),
    );
    expect(redis.redis.del).toHaveBeenCalledWith('lock:payout-batch-draft-tick');
  });

  it('does nothing while the cadence is off, or when the slot was already drafted, or when another instance holds the lock', async () => {
    appConfig.getPlatformSettings.mockResolvedValueOnce({ finance: { payoutBatchCadence: { enabled: false, weekday: 1, hourIst: 10 } } });
    await payoutBatchDraftTick(MONDAY_1030);
    expect(payouts.draftScheduledBatch).not.toHaveBeenCalled();

    redis.redis.set.mockImplementation(async (key: string) => (key === SLOT_KEY ? null : 'OK'));
    await payoutBatchDraftTick(MONDAY_1030);
    expect(payouts.draftScheduledBatch).not.toHaveBeenCalled();

    redis.redis.set.mockResolvedValue(null);
    await payoutBatchDraftTick(MONDAY_1030);
    expect(payouts.draftScheduledBatch).not.toHaveBeenCalled();
    expect(jobs.recordHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('keys the slot on the cadence, so a tick before Monday 10:00 IST is last week’s slot — already drafted', async () => {
    await payoutBatchDraftTick(new Date('2026-09-14T04:00:00Z')); // Monday 09:30 IST
    expect(redis.redis.set).toHaveBeenNthCalledWith(2, 'lock:payout-batch-draft:2026-09-07T04:30:00.000Z', '1', 'EX', 8 * 24 * 60 * 60, 'NX');
  });

  it('drafts nothing and tells nobody when there is nothing to draft', async () => {
    payouts.draftScheduledBatch.mockResolvedValue(null);
    await payoutBatchDraftTick(MONDAY_1030);
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(users.listAdminUserIds).not.toHaveBeenCalled();
  });

  it('skips without a system user, and releases the lock when the draft throws', async () => {
    users.systemUserId.mockResolvedValueOnce(null);
    await payoutBatchDraftTick(MONDAY_1030);
    expect(payouts.draftScheduledBatch).not.toHaveBeenCalled();

    payouts.draftScheduledBatch.mockRejectedValueOnce(new Error('db down'));
    await expect(payoutBatchDraftTick(MONDAY_1030)).resolves.toBeUndefined();
    expect(notifications.createNotification).not.toHaveBeenCalled();
    expect(redis.redis.del).toHaveBeenCalledTimes(2);
  });

  it('names the finance admins by the finance.approve permission', async () => {
    await expect(financeAdminIds()).resolves.toEqual(['adm-super', 'adm-finance']);
  });
});
