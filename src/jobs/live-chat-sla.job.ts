import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sweepLiveChats } from '../modules/support';

const TAG = 'liveChatSlaJob';
const INTERVAL_MS = 60 * 1000;
const LOCK_KEY = 'lock:live-chat-sla-tick';
/** Shorter than the interval on purpose: a tick that dies must not hold the next one out. */
const LOCK_TTL_MS = 50 * 1000;

export let liveChatSlaInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The live-chat sweep — Lot I, every minute.
 *
 * Two silences the desk cannot see: a chat past its first-response target
 * with nobody typing (breach — the inbox is told and every operator on
 * shift is pushed, once per chat), and a chat nobody picked up that has sat
 * for half an hour (converted to a ticket, the requester told). Redis-locked
 * so one instance sweeps; the heartbeat is recorded whether or not it wins
 * the lock, because the ops page is asking whether the job is alive.
 */
export async function liveChatSlaTick(now = new Date()): Promise<void> {
  recordHeartbeat('live-chat-sla', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const summary = await sweepLiveChats(now);
    if (summary.breached.length > 0 || summary.converted.length > 0) {
      logger.info('Live chats swept', { tag: TAG, breached: summary.breached.length, converted: summary.converted.length });
    }
  } catch (err) {
    logger.error('liveChatSlaJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startLiveChatSlaJob(): void {
  liveChatSlaInterval = setInterval(() => void liveChatSlaTick(), INTERVAL_MS);
}
