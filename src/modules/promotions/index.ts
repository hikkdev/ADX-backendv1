/**
 * Promotions — LM-1 (27 Sep 2026): the placements ADX sells. Display ads in
 * ad slots (bought by advertisers, artwork reviewed, rotated in the slot,
 * labelled "Ad") and sponsored listings (bought by publishers for their own
 * listing, shown first in search and in the "Similar listing" row, labelled
 * "Sponsored"). Priced per day plus GST, capacity counted per day, paid from
 * the wallet or through `payments`, refunded in full when rejected.
 */
import { registerSponsoredPort } from '../listings';
import { runningSponsored } from './boosts.service';

export { promotionRouter, appPromotionRouter } from './promotions.routes';

/**
 * Supplies `listings`' SponsoredPort — which listings browse and the similar
 * row put first today. Called by bootstrap/register-modules, because
 * `listings` cannot import this module (it is read here for the listing a
 * boost is for). Unregistered, nothing is sponsored.
 */
export function registerPromotionsModule(): void {
  registerSponsoredPort({ live: (placement, now) => runningSponsored(placement, now) });
}

/** The job's sweep: SCHEDULED → LIVE → ENDED, the unpaid hour, the unreviewed ad. */
export { runPromotionsLifecycle } from './lifecycle.service';
export type { PromotionsSweep } from './lifecycle.service';

/**
 * `payments`' two targets — a gateway intent for an ad (`adBookingId`) or a
 * boost (`listingBoostId`) is priced and guarded here, and its capture is
 * settled here out of the wallet it credited (idempotent).
 */
export { adPaymentTarget, settleAdPayment } from './ads.service';
export { boostPaymentTarget, settleBoostPayment } from './boosts.service';
export type { PromotionPayer, PromotionPaymentTarget } from './ads.service';

/**
 * For `layouts`: an `ad_slot` block resolves to the ads running in the slot
 * today for the city (shuffled; empty = draw nothing), and the console's
 * block form lists the slots to choose from.
 */
export { runningAdsForSlot } from './ads.service';
export type { RunningAd } from './ads.service';
export { listActiveSlots, listAllSlots } from './catalogue.service';
export type { SlotView } from './catalogue.service';

/** The inventory ADX starts with — the seed's rows. */
export { DEFAULT_AD_SLOTS, DEFAULT_BOOST_PLACEMENTS } from './defaults';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
