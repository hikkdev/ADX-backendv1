import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runRightsSweep } from '../modules/supply';

/**
 * QR-24 (the owner, 17 Sep 2026): a hoarding, a digital billboard, a bus
 * shelter — many spots are held on a lease, a licence or a permit that a
 * civic body renews every year, and a publisher who stopped holding it must
 * stop selling it. The listing carries the term (`rightsValidUntil`); this
 * tick reminds the publisher thirty and seven days out, and on the day it
 * runs out marks the spot lapsed — no new booking until a renewed document
 * is reviewed at the desk. Every instance runs the interval; only the one
 * that wins the lock does the work, so a reminder is sent once.
 */

const TAG = 'rightsRenewalJob';
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCK_KEY = 'lock:rights-renewal-tick';
const LOCK_TTL_MS = 5 * 60 * 1000;

export let rightsRenewalInterval: ReturnType<typeof setInterval> | null = null;

export function startRightsRenewalJob(): void {
  rightsRenewalInterval = setInterval(async () => {
    recordHeartbeat('rights-renewal');
    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;
    try {
      const result = await runRightsSweep();
      if (result.considered > 0) logger.info('Rights renewal tick', { tag: TAG, ...result });
    } catch (error) {
      reportError(error, { tag: TAG });
    } finally {
      await redis.del(LOCK_KEY).catch(() => undefined);
    }
  }, INTERVAL_MS);
}
