import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { processPendingDataExports } from '../modules/account-lifecycle';

const TAG = 'dataExportJob';
const INTERVAL_MS = 60 * 1000;
const LOCK_KEY = 'lock:data-export-tick';
const LOCK_TTL_MS = 55 * 1000;
const BATCH = 20;

export let dataExportInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The data export builder — G6 (Q104).
 *
 * Every minute, under a Redis lock so two instances never build the same
 * request: every PENDING `DataExportRequest`, oldest first, assembled into
 * its zip, stored PRIVATE and owned by the person, marked READY for seven
 * days, and the person told by email and push. A build that fails marks its
 * row FAILED with the reason; the person can ask again. The expiry is the
 * retention sweep's (`jobs/retention.job.ts`), not this job's.
 */
export async function dataExportTick(now = new Date()): Promise<void> {
  recordHeartbeat('data-export', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const tally = await processPendingDataExports(BATCH, now);
    if (tally.picked > 0) logger.info('Data exports built', { tag: TAG, ...tally });
  } catch (err) {
    logger.error('dataExportJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startDataExportJob(): void {
  dataExportInterval = setInterval(() => void dataExportTick(), INTERVAL_MS);
}
