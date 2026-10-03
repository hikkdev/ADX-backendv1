import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { authenticate, authenticateOptional, requirePermission, requireRole } from '../../shared/auth';
import { redis } from '../../shared/cache';
import { asyncHandler } from '../../shared/http';
import { requireFeature } from '../feature-flags';
import { handleUploadMiddleware } from '../uploads';
import { ADS_FEATURE, BOOSTS_FEATURE } from './common';
import {
  adminApproveAdHandler,
  adminCancelBoostHandler,
  adminCreateSlotHandler,
  adminGetAdHandler,
  adminGetBoostHandler,
  adminListAdsHandler,
  adminListBoostsHandler,
  adminListPlacementsHandler,
  adminListSlotsHandler,
  adminRejectAdHandler,
  adminStatsHandler,
  adminUpdatePlacementHandler,
  adminUpdateSlotHandler,
  artworkHandler,
  boostAvailabilityHandler,
  boostQuoteHandler,
  cancelAdHandler,
  cancelBoostHandler,
  createAdHandler,
  createBoostHandler,
  eventsHandler,
  getAdHandler,
  getBoostHandler,
  listPlacementsHandler,
  listSlotsHandler,
  myAdsHandler,
  myBoostsHandler,
  payAdHandler,
  payBoostHandler,
  slotAvailabilityHandler,
  submitAdHandler,
  updateAdHandler,
} from './promotions.controller';

/**
 * /promotions — LM-1's paid placements.
 *
 * Four audiences on one router, each guard stated on the route:
 *   - the buyer's reads (slots, placements, availability): signed in or not;
 *   - the advertiser's display ads: signed in, the account's own advertiser,
 *     its agent under the act rule, or ADX on its behalf (`assertMayActFor`);
 *   - the publisher's sponsored listings: signed in, own listing only;
 *   - the desk: ADMIN, `growth.view` to read, `growth.edit` for slots,
 *     placements and prices, `content.approve` to pass or fail artwork.
 * `promotions.ads` / `promotions.boosts` switch the buyer side off (503
 * FEATURE_OFF); the desk stays open either way.
 */
export const promotionRouter = Router();


const ads = requireFeature(ADS_FEATURE);
const boosts = requireFeature(BOOSTS_FEATURE);

// Buyer reads — public.
promotionRouter.get('/slots', authenticateOptional, ads, asyncHandler(listSlotsHandler));
promotionRouter.get('/slots/:key/availability', authenticateOptional, ads, asyncHandler(slotAvailabilityHandler));
promotionRouter.get('/boost/placements', authenticateOptional, boosts, asyncHandler(listPlacementsHandler));
promotionRouter.get('/boost/availability', authenticateOptional, boosts, asyncHandler(boostAvailabilityHandler));

// Display ads — the advertiser.
promotionRouter.post('/ads', authenticate, ads, asyncHandler(createAdHandler));
promotionRouter.get('/ads/mine', authenticate, ads, asyncHandler(myAdsHandler));
promotionRouter.get('/ads/:id', authenticate, ads, asyncHandler(getAdHandler));
promotionRouter.patch('/ads/:id', authenticate, ads, asyncHandler(updateAdHandler));
promotionRouter.post('/ads/:id/artwork', authenticate, ads, handleUploadMiddleware, asyncHandler(artworkHandler));
promotionRouter.post('/ads/:id/submit', authenticate, ads, asyncHandler(submitAdHandler));
promotionRouter.post('/ads/:id/pay-from-wallet', authenticate, ads, asyncHandler(payAdHandler));
promotionRouter.post('/ads/:id/cancel', authenticate, ads, asyncHandler(cancelAdHandler));

// Sponsored listings — the publisher.
promotionRouter.get('/boost/quote', authenticate, boosts, asyncHandler(boostQuoteHandler));
promotionRouter.post('/boosts', authenticate, boosts, asyncHandler(createBoostHandler));
promotionRouter.get('/boosts/mine', authenticate, boosts, asyncHandler(myBoostsHandler));
promotionRouter.get('/boosts/:id', authenticate, boosts, asyncHandler(getBoostHandler));
promotionRouter.post('/boosts/:id/pay-from-wallet', authenticate, boosts, asyncHandler(payBoostHandler));
promotionRouter.post('/boosts/:id/cancel', authenticate, boosts, asyncHandler(cancelBoostHandler));

// The desk.
promotionRouter.get('/admin/slots', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminListSlotsHandler));
promotionRouter.post('/admin/slots', authenticate, requireRole('ADMIN'), requirePermission('growth.edit'), asyncHandler(adminCreateSlotHandler));
promotionRouter.patch('/admin/slots/:id', authenticate, requireRole('ADMIN'), requirePermission('growth.edit'), asyncHandler(adminUpdateSlotHandler));
promotionRouter.get('/admin/placements', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminListPlacementsHandler));
promotionRouter.patch('/admin/placements/:placement', authenticate, requireRole('ADMIN'), requirePermission('growth.edit'), asyncHandler(adminUpdatePlacementHandler));
promotionRouter.get('/admin/ads', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminListAdsHandler));
promotionRouter.get('/admin/ads/:id', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminGetAdHandler));
promotionRouter.post('/admin/ads/:id/approve', authenticate, requireRole('ADMIN'), requirePermission('content.approve'), asyncHandler(adminApproveAdHandler));
promotionRouter.post('/admin/ads/:id/reject', authenticate, requireRole('ADMIN'), requirePermission('content.approve'), asyncHandler(adminRejectAdHandler));
promotionRouter.get('/admin/boosts', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminListBoostsHandler));
promotionRouter.get('/admin/boosts/:id', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminGetBoostHandler));
promotionRouter.post('/admin/boosts/:id/cancel', authenticate, requireRole('ADMIN'), requirePermission('growth.edit'), asyncHandler(adminCancelBoostHandler));
promotionRouter.get('/admin/stats', authenticate, requireRole('ADMIN'), requirePermission('growth.view'), asyncHandler(adminStatsHandler));

/**
 * The events a client sends — public, keyed by IP. A person on a page sees a
 * handful of ads and taps fewer; the cap is what stops a script inflating a
 * buyer's numbers (and an event naming nothing running today is dropped
 * anyway). A Redis outage lets the request through rather than refusing it.
 */
export const promotionEventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  message: { success: false, error: 'Too many events. Please slow down.' },
  store: new RedisStore({
    prefix: 'rl:promotion-events:',
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>,
  }),
});

/** /app/promotions — the counters the clients feed. */
export const appPromotionRouter = Router();
appPromotionRouter.post('/events', promotionEventsLimiter, asyncHandler(eventsHandler));
