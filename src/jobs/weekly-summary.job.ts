import { redis, orSkipWhenRedisDown } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { env } from '../config/env';
import { isMondayMorningIST, runWeeklySummaries, weekKeyIST } from '../modules/campaigns';

const TAG = 'weeklySummaryJob';
const INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'lock:weekly-summary-tick';
const LOCK_TTL_MS = 14 * 60 * 1000;
/** Once per week: the first tick on Monday at or after 09:00 IST does the week. */
const WEEK_KEY = (week: string) => `lock:weekly-summary:${week}`;

export let weeklySummaryInterval: ReturnType<typeof setInterval> | null = null;

/**
 * WS-1 (DR 12): every advertiser's weekly campaign summary, Monday morning
 * Indian time. An interval rather than a cron so a process that started at
 * noon on Monday still sends the week; the week lock is what makes it once.
 */
export function startWeeklySummaryJob(): void {
  weeklySummaryInterval = setInterval(async () => {
    recordHeartbeat('weekly-summary');
    const now = new Date();
    if (!isMondayMorningIST(now)) return;

    // Redis away (Docker stopped): skip this tick rather than take the API down.
    const acquired = await orSkipWhenRedisDown(redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX'), TAG);
    if (!acquired) return;

    try {
      const first = await redis.set(WEEK_KEY(weekKeyIST(now)), '1', 'EX', 60 * 60 * 24 * 10, 'NX');
      if (!first) return;
      const link = env.PUBLIC_WEB_URL ? `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/advertiser/campaigns` : '';
      const result = await runWeeklySummaries(now, { link });
      logger.info('Weekly campaign summaries', { tag: TAG, ...result });
    } catch (err) {
      logger.error('weeklySummaryJob tick failed', { tag: TAG, err });
      void reportError(err, { tag: TAG });
    }
  }, INTERVAL_MS);
}
