import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { flushQueued, purgeRecordings, tickSequences } from '../modules/leads';

const TAG = 'leadOutreachTickJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:lead-outreach-tick';
const LOCK_TTL_MS = 4 * 60 * 1000;
const PURGE_KEY = 'lead-outreach:recordings-purged';
const PURGE_TTL_SECONDS = 20 * 60 * 60;

export let leadOutreachTickInterval: ReturnType<typeof setInterval> | null = null;

/**
 * LH6: every five minutes — the messages the quiet hours held back leave,
 * the sequence steps that came due go (or land as tasks), and once a day
 * the call recordings older than 90 days are purged (D5). One instance at
 * a time under a Redis lock; every write is idempotent on its row.
 */
export async function leadOutreachTick(now = new Date()): Promise<void> {
  recordHeartbeat('lead-outreach-tick', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const flushed = await flushQueued(now);
    const stepped = await tickSequences(now);
    if (flushed.sent || flushed.failed || stepped.picked) logger.info('Outreach ticked', { tag: TAG, flushed, stepped });
    const purgeDue = await redis.set(PURGE_KEY, '1', 'EX', PURGE_TTL_SECONDS, 'NX');
    if (purgeDue === 'OK') {
      const purged = await purgeRecordings(now);
      if (purged) logger.info('Call recordings purged', { tag: TAG, purged });
    }
  } catch (err) {
    logger.error('leadOutreachTickJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startLeadOutreachTickJob(): void {
  leadOutreachTickInterval = setInterval(() => void leadOutreachTick(), INTERVAL_MS);
}
