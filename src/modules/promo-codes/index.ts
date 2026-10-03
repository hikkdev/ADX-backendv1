/**
 * Promo codes — PC-1 (DR 12, 25 Sep 2026).
 *
 * The desk router, and the narrow surface `campaigns` uses to put a code on
 * a booking and count it when the booking is paid. This module imports
 * nothing from `campaigns`, so the dependency runs one way.
 */
import './features';

export { promoCodeRouter } from './promo-codes.routes';
export {
  countRedemptions,
  discountFor,
  findPromoByCode,
  normaliseCode,
  promoProblem,
  recordRedemption,
  releaseRedemption,
} from './promo-codes.service';
export type { PromoCodeView, PromoContext } from './promo-codes.service';
export { applyPromoCodeSchema } from './promo-codes.schema';
