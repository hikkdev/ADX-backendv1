import { cancelUnpaidAds, endFinishedAds, expireUnreviewedAds, startDueAds } from './ads.service';
import { cancelUnpaidBoosts, clearSponsoredCache, endFinishedBoosts, startDueBoosts } from './boosts.service';

/**
 * LM-1 — paid placements crossing their own dates, run by the promotions
 * job every five minutes: SCHEDULED → LIVE on the first day, LIVE → ENDED
 * after the last, a priced booking unpaid for an hour → CANCELLED (its days
 * freed), and an ad paid for but never reviewed before its last day →
 * CANCELLED and refunded. Every transition is guarded on the status it
 * leaves, so two instances ticking together move each booking once.
 */
export type PromotionsSweep = { adsLive: number; adsEnded: number; adsUnpaid: number; adsUnreviewed: number; boostsLive: number; boostsEnded: number; boostsUnpaid: number };

export async function runPromotionsLifecycle(now = new Date()): Promise<PromotionsSweep> {
  const adsUnpaid = await cancelUnpaidAds(now);
  const boostsUnpaid = await cancelUnpaidBoosts(now);
  const adsLive = await startDueAds(now);
  const boostsLive = await startDueBoosts(now);
  const adsEnded = await endFinishedAds(now);
  const boostsEnded = await endFinishedBoosts(now);
  const adsUnreviewed = await expireUnreviewedAds(now);
  if (boostsLive || boostsEnded || boostsUnpaid) clearSponsoredCache();
  return { adsLive, adsEnded, adsUnpaid, adsUnreviewed, boostsLive, boostsEnded, boostsUnpaid };
}
