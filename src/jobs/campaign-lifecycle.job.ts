import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { expireSpotReservations, runCampaignTransitions, snapshotDailyMetrics } from '../modules/campaigns';
import { runPackageExpiry } from '../modules/packages';

const TAG = 'campaignLifecycleJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:campaign-lifecycle-tick';
// Shorter than the interval: an instance that dies mid-tick clears its own lock
// before the next one is due, rather than stalling the job for five minutes.
const LOCK_TTL_MS = 4 * 60 * 1000;

/** Only the first tick after midnight UTC writes the day's snapshot. */
const SNAPSHOT_KEY = (day: string) => `lock:campaign-snapshot:${day}`;

export let campaignLifecycleInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Campaigns cross their own dates.
 *
 * A scheduled campaign whose start has arrived goes live and its hold becomes a
 * debit; a live one whose end has passed completes. Nobody presses anything for
 * either, so this is the thing that makes a booked campaign a running one.
 *
 * Five minutes rather than a minute: a campaign starting five minutes late
 * costs nothing, and this tick reads every live campaign's spots.
 */
export function startCampaignLifecycleJob(): void {
  campaignLifecycleInterval = setInterval(async () => {
    recordHeartbeat('campaign-lifecycle');
    // Every instance runs the interval; only the one that wins the lock does the
    // work, or a campaign's hold would be captured once per instance.
    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;

    try {
      // Lot D (Q120): `blocked` is a campaign due to start whose artwork ops
      // have not approved — left SCHEDULED, ops told once a day.
      // QR-16: `awaitingVerification` is a paid campaign held until its advertiser's KYC clears.
      const { wentLive, completed, skipped, blocked, awaitingVerification } = await runCampaignTransitions();
      if (wentLive > 0 || completed > 0 || skipped > 0 || blocked > 0 || awaitingVerification > 0) {
        logger.info('Campaign lifecycle tick', { tag: TAG, wentLive, completed, skipped, blocked, awaitingVerification });
      }

      // Lot C (Q88): a campaign sent to its advertiser to pay holds its spots
      // for 24 hours; a hold that has lapsed goes back to a plain reservation.
      const { cleared } = await expireSpotReservations();
      if (cleared > 0) logger.info('Spot reservations expired', { tag: TAG, cleared });

      // Package terms end on the same tick. Nothing auto-renews — a mandate
      // needs a gateway ADX has not chosen — so an expired plan is a sale
      // somebody has to make again.
      const { expired } = await runPackageExpiry();
      if (expired > 0) logger.info('Packages expired', { tag: TAG, expired });

      /*
       * Yesterday's numbers, frozen. The analytics endpoints compute from source
       * so the screens do not depend on this, but a spot cancelled tomorrow
       * would otherwise quietly rewrite what last week looked like.
       */
      const day = new Date().toISOString().slice(0, 10);
      const firstToday = await redis.set(SNAPSHOT_KEY(day), '1', 'EX', 60 * 60 * 26, 'NX');
      if (firstToday) {
        const { written } = await snapshotDailyMetrics();
        if (written > 0) logger.info('Campaign metrics snapshot', { tag: TAG, written, day });
      }
    } catch (err) {
      logger.error('campaignLifecycleJob tick failed', { tag: TAG, err });
      void reportError(err, { tag: TAG });
    }
  }, INTERVAL_MS);
}
