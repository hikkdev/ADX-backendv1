import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { retentionSweep } from '../modules/ops';

const TAG = 'retentionJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:retention-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:retention:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let retentionInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The retention sweep — Lot E (decisions 95/126), daily.
 *
 * Tells the admins once about every erasure request past its thirty days,
 * and writes the list of erased people whose financial rows have outlived
 * their retention to `ops:retention-due`. It destroys nothing: the ledger is
 * append-only and a person decides what happens to the report. The
 * `NotificationDelivery` purge is the notifications work's own (E1).
 *
 * Runs on an hourly interval rather than a cron so a process that started at
 * noon still catches the day; the day lock is what makes it once.
 */
export async function retentionTick(now = new Date()): Promise<void> {
  recordHeartbeat('retention', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;

    const result = await retentionSweep(now);
    logger.info('Retention sweep', {
      tag: TAG,
      erasureOverdue: result.erasureDue.outstanding,
      newlyNotified: result.erasureDue.notified.length,
      retentionDue: result.retentionDue.count,
    });
  } catch (err) {
    logger.error('retentionJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startRetentionJob(): void {
  retentionInterval = setInterval(() => void retentionTick(), INTERVAL_MS);
}
