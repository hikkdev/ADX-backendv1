import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { isFirstOfMonthIST, previousMonth, runMonthlyStatements } from '../modules/invoices';

const TAG = 'monthlyStatementsJob';
const INTERVAL_MS = 30 * 60 * 1000;
const LOCK_KEY = 'lock:monthly-statements-tick';
// Shorter than the interval, so an instance that dies mid-run clears its own
// lock rather than holding every publisher's advice until a restart.
const LOCK_TTL_MS = 25 * 60 * 1000;

/** Only the first tick on the first of the month, in Indian time, does the month's work. */
const MONTH_KEY = (period: string) => `lock:monthly-statements:${period}`;

export let monthlyStatementsInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Publishers' payment advices, once a month — Lot B (Q13).
 *
 * The first of the month, Indian time, for the month just ended: for every
 * publisher who earned anything in it, one PDF into the `Statement` table
 * DR 04 created, which is what the app's Statements screen downloads.
 *
 * Runs on an interval rather than a cron so a process that started at noon
 * on the 1st still catches the month; the month lock is what makes it once.
 * The generation itself is keyed on (wallet, month) and safe to run again —
 * the lock only saves the work.
 */
export function startMonthlyStatementsJob(): void {
  monthlyStatementsInterval = setInterval(async () => {
    recordHeartbeat('monthly-statements');
    const now = new Date();
    if (!isFirstOfMonthIST(now)) return;

    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;

    try {
      const window = previousMonth(now);
      const first = await redis.set(MONTH_KEY(window.period), '1', 'EX', 60 * 60 * 24 * 40, 'NX');
      if (!first) return;

      const result = await runMonthlyStatements(window, now);
      logger.info('Monthly payment advices', { tag: TAG, ...result });
    } catch (err) {
      logger.error('monthlyStatementsJob tick failed', { tag: TAG, err });
      void reportError(err, { tag: TAG });
    }
  }, INTERVAL_MS);
}
