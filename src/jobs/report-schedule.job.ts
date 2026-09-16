import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runDueSchedules } from '../modules/reports';

const TAG = 'reportScheduleJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:report-schedule-tick';
/** A monthly report over a big table can take a while; the lock outlives the interval so two instances never render the same schedule. */
const LOCK_TTL_MS = 20 * 60 * 1000;

export let reportScheduleInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Scheduled reports — Lot G (Q129/Q143), every five minutes.
 *
 * One instance per tick (Redis lock). Every enabled schedule whose
 * `nextRunAt` has passed is rendered for its cadence's window (yesterday,
 * the last seven days, last month), each recipient is mailed a signed link
 * through `notify('REPORT_READY')`, and `nextRunAt` moves to the next
 * 06:00 IST the cadence names — whether or not the run succeeded, so a
 * failing report fails once a period, not once a tick.
 */
export async function reportScheduleTick(now = new Date()): Promise<void> {
  recordHeartbeat('report-schedule', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const outcomes = await runDueSchedules(now);
    if (outcomes.length > 0) {
      logger.info('Scheduled reports ran', {
        tag: TAG,
        count: outcomes.length,
        failed: outcomes.filter((o) => o.status === 'FAILED').length,
        mailed: outcomes.reduce((sum, o) => sum + o.recipients, 0),
      });
    }
  } catch (err) {
    logger.error('reportScheduleJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export function startReportScheduleJob(): void {
  reportScheduleInterval = setInterval(() => void reportScheduleTick(), INTERVAL_MS);
}
