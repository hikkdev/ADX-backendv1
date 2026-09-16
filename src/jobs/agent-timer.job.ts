import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { expireAgentOffers } from '../modules/orders';
import { expireMilestoneOffers } from '../modules/order-milestones';
import { expireVisitOffers } from '../modules/visits';

/**
 * The agent's acceptance window, enforced.
 *
 * DR 01 draws "Expires in 25 Minutes" over the accept button, and until now
 * the stamp behind that countdown was written and never read: an offer nobody
 * answered sat on one agent for ever, and a late tap took it anyway. Every
 * minute this records the offers whose window closed in the last tick as
 * EXPIRED on their assignment and hands each to the next eligible agent —
 * the same re-offer a rejection triggers — so the clock on the sheet is the
 * clock ADX keeps. The lock keeps N instances from re-offering the same job.
 */

const TAG = 'agentTimerJob';
const INTERVAL_MS = 60 * 1000;
const LOCK_KEY = 'lock:agent-timer-tick';
const LOCK_TTL_MS = 45 * 1000;

export let agentTimerInterval: ReturnType<typeof setInterval> | null = null;

export function startAgentTimerJob(): void {
  agentTimerInterval = setInterval(async () => {
    recordHeartbeat('agent-timer');
    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;

    try {
      const now = new Date();
      // Only the window that closed since the last tick: an offer is expired
      // once, and the re-offer stamps a fresh deadline for the next agent.
      const windowStart = new Date(now.getTime() - INTERVAL_MS);
      const expired = await expireAgentOffers(windowStart, now);
      // A12: the same window on a visit offered to an advertiser-side agent.
      const visits = await expireMilestoneOffers(windowStart, now);
      // DR 06: the same clock on a field visit — an onboarding or renewal call
      // ADX dispatched to a named agent.
      const fieldVisits = await expireVisitOffers({ start: windowStart, end: now });
      logger.info('Agent timer tick', { tag: TAG, expired: expired.length, visits: visits.length, fieldVisits });
    } catch (err) {
      logger.error('Agent timer tick failed', { tag: TAG, err });
      void reportError(err, { tag: TAG });
    }
  }, INTERVAL_MS);
}
