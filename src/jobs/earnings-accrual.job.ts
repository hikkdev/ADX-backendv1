import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runDailyAccrual } from '../modules/payouts';

const TAG = 'earningsAccrualJob';
const INTERVAL_MS = 15 * 60 * 1000;
const LOCK_KEY = 'lock:earnings-accrual-tick';
// Shorter than the interval, so an instance that dies mid-tick clears its own
// lock rather than stalling every publisher's earnings until it is restarted.
const LOCK_TTL_MS = 12 * 60 * 1000;

/** Only the first tick after midnight UTC does the day's work. */
const DAY_KEY = (day: string) => `lock:earnings-accrual:${day}`;

export let earningsAccrualInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Publisher earnings, a day at a time.
 *
 * The rule this exists for: money arrives as a campaign runs rather than at its
 * end, so each day that finishes adds that day's share to the publisher's
 * wallet. Nobody presses anything, which makes this the only thing standing
 * between a live campaign and a publisher being paid.
 *
 * Runs once per UTC day rather than on every tick — a day's earnings are a
 * day's earnings, and the interval is only there so a process that started at
 * noon still catches today. The accrual itself is keyed on (spot, day) and is
 * safe to run again regardless; the day lock just saves the work.
 */
export function startEarningsAccrualJob(): void {
  earningsAccrualInterval = setInterval(async () => {
    recordHeartbeat('earnings-accrual');
    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;

    try {
      const day = new Date().toISOString().slice(0, 10);
      const firstToday = await redis.set(DAY_KEY(day), '1', 'EX', 60 * 60 * 26, 'NX');
      if (!firstToday) return;

      const result = await runDailyAccrual();
      if (result.daysCredited > 0 || result.skipped > 0) {
        logger.info('Daily earnings accrual', {
          tag: TAG,
          day,
          daysCredited: result.daysCredited,
          totalNet: result.totalNet,
          skipped: result.skipped,
          spotsConsidered: result.spotsConsidered,
        });
      }
    } catch (err) {
      logger.error('earningsAccrualJob tick failed', { tag: TAG, err });
      void reportError(err, { tag: TAG });
    }
  }, INTERVAL_MS);
}
