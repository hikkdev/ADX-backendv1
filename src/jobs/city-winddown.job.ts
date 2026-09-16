import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runCityWindDown } from '../modules/geo';
import { listAdminUserIds, systemUserId } from '../modules/users';

const TAG = 'cityWindDownJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:city-winddown-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;

export let cityWindDownInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The hourly wind-down of a withdrawn city — Lot V.
 *
 * Ops set a city WITHDRAWN (`PATCH /geo/cities/:slug/rollout`); the gates
 * shut at once, and this tick does the rest within the hour: the live
 * listings off the market, the open leads closed, the publishers and
 * agents told — `geo.runCityWindDown`, one city at a time, as the system
 * user. Idempotent by the marker event the service writes, so a tick that
 * finds every withdrawn city already wound down does nothing. No day key:
 * a city withdrawn at noon should be down by one, not tomorrow.
 */
export async function cityWindDownTick(now = new Date()): Promise<void> {
  recordHeartbeat('city-winddown', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const actor = (await systemUserId()) ?? (await listAdminUserIds())[0] ?? null;
    if (!actor) {
      logger.warn('City wind-down skipped: no system user and no admin to act as', { tag: TAG });
      return;
    }
    const summaries = await runCityWindDown(actor, now);
    if (summaries.length > 0) logger.info('Cities wound down', { tag: TAG, cities: summaries });
  } catch (err) {
    logger.error('cityWindDownJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export function startCityWindDownJob(): void {
  cityWindDownInterval = setInterval(() => void cityWindDownTick(), INTERVAL_MS);
}
