import { redis, orSkipWhenRedisDown } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runStorageSweepExclusive } from '../modules/uploads';
import { listAdminUserIds, systemUserId } from '../modules/users';

const TAG = 'storageSweepJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:storage-sweep-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a week: the week key is what makes it once. */
const WEEK_KEY = (week: string) => `lock:storage-sweep:${week}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The sweep's week starts Monday 03:00 IST — the quiet hour, not midnight. */
const WEEK_START_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export let storageSweepInterval: ReturnType<typeof setInterval> | null = null;

/** The Monday (YYYY-MM-DD) of the sweep's week — the IST week, shifted to begin at 03:00. */
export function sweepWeekKey(now: Date): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS - WEEK_START_OFFSET_MS);
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  return new Date(shifted.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The storage sweep — ST-3 (28 Sep 2026), weekly.
 *
 * Marks every file nothing on the platform refers to and clears the mark on
 * the ones something refers to again; removes a file only after it stayed
 * unreferenced for the grace period AND only when Settings › Storage has
 * removal on (off by default). The retention-governed purposes are never
 * touched. `uploads/sweep.service.ts` has the rules.
 *
 * An hourly interval rather than a cron, like the retention sweep, so a
 * process that started mid-week still runs the week; the week key is what
 * makes it once. The removal is audited under the system user.
 */
export async function storageSweepTick(now = new Date()): Promise<void> {
  recordHeartbeat('storage-sweep', now);
  // Redis away (Docker stopped): skip this tick rather than take the API down.
  const acquired = await orSkipWhenRedisDown(redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX'), TAG);
  if (!acquired) return;

  try {
    const first = await redis.set(WEEK_KEY(sweepWeekKey(now)), '1', 'EX', 60 * 60 * 24 * 10, 'NX');
    if (!first) return;

    const actor = (await systemUserId()) ?? (await listAdminUserIds())[0] ?? null;
    const run = await runStorageSweepExclusive({ now, trigger: 'SCHEDULE', actorUserId: actor });
    if (!run) {
      logger.info('Storage sweep skipped — another sweep is running', { tag: TAG });
      return;
    }
    logger.info('Storage sweep', {
      tag: TAG,
      checked: run.mark.checked,
      marked: run.mark.marked,
      cleared: run.mark.cleared,
      unreferenced: run.mark.unreferenced,
      rowsRead: run.mark.rowsRead,
      protectedUnreferenced: run.mark.protectedUnreferenced,
      removed: run.removal.removed,
      removedBytes: run.removal.removedBytes,
      removalHeld: run.removal.held,
      keptWithoutStorageKey: run.removal.keptWithoutStorageKey,
      durationMs: run.durationMs,
    });
  } catch (err) {
    logger.error('storageSweepJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startStorageSweepJob(): void {
  storageSweepInterval = setInterval(() => void storageSweepTick(), INTERVAL_MS);
}
