import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sweepTrails } from '../modules/agent-locations';

const TAG = 'agentTrailRetentionJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:agent-trail-retention-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
const DAY_KEY = (day: string) => `lock:agent-trail-retention:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let agentTrailRetentionInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * LT-1: once a day, the trails and their fixes older than
 * `tracking.retentionDays` go. Hourly interval, day lock — the same shape
 * as the print-quote expiry.
 */
export async function agentTrailRetentionTick(now = new Date()): Promise<void> {
  recordHeartbeat('agent-trail-retention', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;
    const summary = await sweepTrails(now);
    logger.info('Agent trails swept', { tag: TAG, ...summary });
  } catch (err) {
    logger.error('agentTrailRetentionJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startAgentTrailRetentionJob(): void {
  agentTrailRetentionInterval = setInterval(() => void agentTrailRetentionTick(), INTERVAL_MS);
}
