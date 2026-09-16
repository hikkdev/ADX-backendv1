import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { defaultDrillDeps, runRestoreDrill } from '../modules/ops';
import { systemUserId } from '../modules/users';

const TAG = 'restoreDrillJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:restore-drill-tick';
// A restore of a real dump can take a while; the lock outlives the interval
// so a second instance never starts a second restore into the same scratch
// database, and it still clears itself if the process dies mid-run.
const LOCK_TTL_MS = 3 * 60 * 60 * 1000;
/** Once a month, Indian time: the month key is what makes it once. */
const MONTH_KEY = (month: string) => `lock:restore-drill:${month}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The drill runs on the first tick on or after this day of the month, so the month's first nightly dump exists. */
const DRILL_DAY_OF_MONTH = 2;

export let restoreDrillInterval: ReturnType<typeof setInterval> | null = null;

const istMonth = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
const istDayOfMonth = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).getUTCDate();

/**
 * The monthly restore drill — Lot E (decision 95).
 *
 * Restores the newest nightly dump into DRILL_DATABASE_URL and runs the
 * ledger verify against it; the result lands in `ops:last-drill`, the audit
 * trail (`BACKUP_DRILL_RUN`) and, on failure, every admin's notifications.
 * Unset, the drill skips with a warning. The month lock makes it once; the
 * tick lock keeps two instances from restoring at the same time.
 */
export async function restoreDrillTick(now = new Date()): Promise<void> {
  recordHeartbeat('restore-drill', now);
  if (istDayOfMonth(now) < DRILL_DAY_OF_MONTH) return;

  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(MONTH_KEY(istMonth(now)), '1', 'EX', 60 * 60 * 24 * 40, 'NX');
    if (!first) return;

    // E7-2: the job's row is the system account's, like every other job's.
    const actor = await systemUserId();
    const outcome = await runRestoreDrill(defaultDrillDeps(actor), now);
    logger.info('Restore drill', { tag: TAG, status: outcome.status, dump: outcome.dump?.name ?? null });
  } catch (err) {
    logger.error('restoreDrillJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export function startRestoreDrillJob(): void {
  restoreDrillInterval = setInterval(() => void restoreDrillTick(), INTERVAL_MS);
}
