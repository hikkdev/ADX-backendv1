import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sampleHealth } from '../modules/ops';

const TAG = 'healthSampleJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:health-sample-tick';
// Shorter than the interval, so an instance that dies mid-probe clears its own lock.
const LOCK_TTL_MS = 4 * 60 * 1000;

export let healthSampleInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The health sampler — Lot G (Q130), every five minutes.
 *
 * One instance per tick (Redis lock). Writes one `HealthSample` per service
 * — API (the previous minute's p95 from the request logger), POSTGRES and
 * REDIS (the readiness pings), STORAGE (a HEAD on the bucket) and JOBS
 * (every heartbeat fresh) — and prunes samples past thirty days. The
 * heartbeat is recorded first, so this job's own row in the JOBS sample is
 * fresh on the tick that writes it.
 */
export async function healthSampleTick(now = new Date()): Promise<void> {
  recordHeartbeat('health-sample', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const result = await sampleHealth(now);
    const down = result.samples.filter((s) => !s.ok).map((s) => s.service);
    if (down.length > 0) logger.warn('Health sample: services down', { tag: TAG, down });
    if (result.pruned > 0) logger.info('Health samples pruned', { tag: TAG, pruned: result.pruned });
  } catch (err) {
    logger.error('healthSampleJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startHealthSampleJob(): void {
  // The first sample soon after boot, so the status page is not UNKNOWN for five minutes.
  setTimeout(() => void healthSampleTick(), 15_000).unref();
  healthSampleInterval = setInterval(() => void healthSampleTick(), INTERVAL_MS);
}
