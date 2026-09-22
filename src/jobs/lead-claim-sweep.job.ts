import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sweepClaims } from '../modules/leads';

const TAG = 'leadClaimSweepJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:lead-claim-sweep-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;

export let leadClaimSweepInterval: ReturnType<typeof setInterval> | null = null;

/**
 * LH5 (D3): every hour, a claim past its 72-hour hold with no work logged
 * goes back to the pool (a worked one simply ends its hold and stays with
 * the agent), and the holder of a claim lapsing within the hour is warned
 * once. Idempotent: a claim closes once, the warning is keyed on the claim.
 */
export async function leadClaimSweepTick(now = new Date()): Promise<void> {
  recordHeartbeat('lead-claim-sweep', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const result = await sweepClaims(now);
    if (result.lapsed || result.warned) logger.info('Lead claims swept', { tag: TAG, ...result });
  } catch (err) {
    logger.error('leadClaimSweepJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startLeadClaimSweepJob(): void {
  leadClaimSweepInterval = setInterval(() => void leadClaimSweepTick(), INTERVAL_MS);
}
