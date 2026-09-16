import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runDueSources } from '../modules/pricing';

/**
 * Runs every due event source and turns what they publish into surge windows.
 *
 * Ticks often; each source decides its own cadence through `intervalMinutes`,
 * so this only asks which are due. That keeps the schedule where an operator can
 * change it rather than in a deploy.
 */

const TAG = 'eventScraperJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:event-scraper-tick';

/**
 * Longer than the tick, unlike the publisher timer's lock.
 *
 * A pass over a dozen sources is a dozen sequential HTTP fetches against other
 * people's servers, each with a 20-second ceiling. A lock that expired mid-pass
 * would let the next tick start a second pass over the same sources, which is
 * both duplicated work and exactly the burst of traffic that gets a crawler
 * blocked.
 */
const LOCK_TTL_MS = 10 * 60 * 1000;

export let eventScraperInterval: ReturnType<typeof setInterval> | null = null;

export function startEventScraperJob(): void {
  eventScraperInterval = setInterval(() => {
    recordHeartbeat('event-scraper');
    void (async () => {
      // Every instance ticks; only the one that takes the lock does the work.
      // Without it, N instances would each fetch every source and write the same
      // windows N times over.
      const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
      if (!acquired) return;

      try {
        const outcomes = await runDueSources();
        if (outcomes.length === 0) return;

        logger.info('Event scraper tick', {
          tag: TAG,
          sources: outcomes.length,
          windows: outcomes.reduce((sum, outcome) => sum + outcome.windowsUpserted, 0),
          // Surfaced deliberately: a source that fetches fine and matches
          // nothing is the failure that otherwise shows up months later as an
          // empty surge calendar nobody questioned.
          noMatches: outcomes.filter((outcome) => outcome.status === 'NO_MATCHES').length,
          failed: outcomes.filter(
            (outcome) => outcome.status === 'FETCH_FAILED' || outcome.status === 'PARSE_FAILED'
          ).length,
        });
      } catch (cause) {
        // A thrown tick must not take the process with it: this is a background
        // enrichment, and the marketplace works without it.
        logger.error('Event scraper tick failed', {
          tag: TAG,
          reason: cause instanceof Error ? cause.message : 'unknown',
        });
        void reportError(cause, { tag: TAG });
      } finally {
        await redis.del(LOCK_KEY);
      }
    })();
  }, INTERVAL_MS);
}
