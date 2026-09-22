import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sampleQa, scanIntegrity, watchClawbacks } from '../modules/leads';

const TAG = 'leadIntegrityJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:lead-integrity';
const LOCK_TTL_MS = 50 * 60 * 1000;
const DAILY_KEY = 'lead-integrity:sampled';
const DAILY_TTL_SECONDS = 20 * 60 * 60;

export let leadIntegrityInterval: ReturnType<typeof setInterval> | null = null;

/**
 * LH10: every hour the integrity scan reads the last two days of leads for
 * the four patterns and opens a flag for a person to decide, and the
 * clawback watch reads the activations of the last thirty days for an
 * account that closed or whose business came down. Once a day, the QA draw
 * takes its share of yesterday's visits and recorded calls. One instance at
 * a time under a Redis lock; every write is idempotent on its row.
 */
export async function leadIntegrityTick(now = new Date()): Promise<void> {
  recordHeartbeat('lead-integrity', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const scanned = await scanIntegrity(now);
    const clawed = await watchClawbacks(now);
    if (scanned.flagged || clawed.reversed) logger.info('Lead integrity swept', { tag: TAG, scanned, clawed });
    const sampleDue = await redis.set(DAILY_KEY, '1', 'EX', DAILY_TTL_SECONDS, 'NX');
    if (sampleDue === 'OK') {
      const sampled = await sampleQa(now);
      if (sampled.visits || sampled.calls) logger.info('Field work sampled', { tag: TAG, sampled });
    }
  } catch (err) {
    logger.error('leadIntegrityJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startLeadIntegrityJob(): void {
  leadIntegrityInterval = setInterval(() => void leadIntegrityTick(), INTERVAL_MS);
}
