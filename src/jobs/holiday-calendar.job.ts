import { redis, orSkipWhenRedisDown } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runScheduledHolidaySync } from '../modules/hr';

const TAG = 'holidayCalendarJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:holiday-calendar-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a week: the week key is what makes it once. */
const WEEK_KEY = (week: string) => `lock:holiday-calendar:${week}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The sync's week starts Monday 03:00 IST — the quiet hour, not midnight. */
const WEEK_START_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export let holidayCalendarInterval: ReturnType<typeof setInterval> | null = null;

/** The Monday (YYYY-MM-DD) of the sync's week — the IST week, shifted to begin at 03:00. */
export function holidayWeekKey(now: Date): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS - WEEK_START_OFFSET_MS);
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  return new Date(shifted.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The holiday calendar sync — HC-1 (1 Oct 2026), weekly.
 *
 * Reads the public holiday calendar Settings › Integrations names and
 * reconciles this year and next (`hr/holiday-calendar.service.ts` has the
 * rules); does nothing while the calendar is switched off. The storage
 * sweep's pattern: an hourly tick, so a process that started mid-week still
 * runs the week, and the week key is what makes it once. A feed that cannot
 * be read is recorded as the last run's error by the sync itself.
 */
export async function holidayCalendarTick(now = new Date()): Promise<void> {
  recordHeartbeat('holiday-calendar', now);
  // Redis away (Docker stopped): skip this tick rather than take the API down.
  const acquired = await orSkipWhenRedisDown(redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX'), TAG);
  if (!acquired) return;

  try {
    const first = await redis.set(WEEK_KEY(holidayWeekKey(now)), '1', 'EX', 60 * 60 * 24 * 10, 'NX');
    if (!first) return;

    const result = await runScheduledHolidaySync(now);
    if (result) logger.info('Holiday calendar sync', { tag: TAG, ...result });
  } catch (err) {
    logger.error('holidayCalendarJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startHolidayCalendarJob(): void {
  holidayCalendarInterval = setInterval(() => void holidayCalendarTick(), INTERVAL_MS);
}
