import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sweepDueTasks } from '../modules/work';

const TAG = 'workDueJob';
const INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'lock:work-due-tick';
const LOCK_TTL_MS = 10 * 60 * 1000;
/** Once a day, Indian time, from 08:00: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:work-due:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SEND_FROM_HOUR_IST = 8;

export let workDueInterval: ReturnType<typeof setInterval> | null = null;

const ist = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS);
const istDay = (now: Date) => ist(now).toISOString().slice(0, 10);

/**
 * The work due sweep — Lot AA, daily at 08:00 IST.
 *
 * Every quarter hour the tick heartbeats; from eight in the morning, Indian
 * time, the first tick of the day runs the sweep: the assignees of every
 * task due tomorrow and every task overdue are told, once — the service
 * keeps a per-task, per-day key, so a second run the same day tells nobody
 * twice. A tick before eight does nothing but heartbeat.
 */
export async function workDueTick(now = new Date()): Promise<void> {
  recordHeartbeat('work-due', now);
  if (ist(now).getUTCHours() < SEND_FROM_HOUR_IST) return;
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;
    const report = await sweepDueTasks(now);
    logger.info('Work due notices sent', { tag: TAG, day: istDay(now), ...report });
  } catch (err) {
    logger.error('workDueJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export function startWorkDueJob(): void {
  workDueInterval = setInterval(() => void workDueTick(), INTERVAL_MS);
}
