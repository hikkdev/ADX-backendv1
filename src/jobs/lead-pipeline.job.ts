import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { recycleDue, watchRetention } from '../modules/leads';

const TAG = 'leadPipelineJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:lead-pipeline-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;

export let leadPipelineInterval: ReturnType<typeof setInterval> | null = null;

/**
 * LH2: every hour, the retention watch reads each converted lead's account
 * for the catch (first listing live / first campaign paid → ACTIVATED) and
 * the trailing reward (a second booking / campaign, or thirty days live →
 * RETAINED), and the recycle brings PRICE / TIMING losses back after sixty
 * days. Both are idempotent — a stage moves once, an incentive records once.
 */
export async function leadPipelineTick(now = new Date()): Promise<void> {
  recordHeartbeat('lead-pipeline', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const watched = await watchRetention(now);
    const recycled = await recycleDue(now);
    if (watched.activated || watched.retained || recycled.recycled) logger.info('Lead pipeline moved', { tag: TAG, ...watched, ...recycled });
  } catch (err) {
    logger.error('leadPipelineJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startLeadPipelineJob(): void {
  leadPipelineInterval = setInterval(() => void leadPipelineTick(), INTERVAL_MS);
}
