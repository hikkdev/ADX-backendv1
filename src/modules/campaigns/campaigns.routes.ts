import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { trackingInteractionLimiter } from '../../shared/security';
import { requireFeature, requireFeatureWhen } from '../feature-flags';
import {
  acceptCreativeHandler,
  authorizeHandler,
  bulkReviewHandler,
  campaignAnalyticsHandler,
  cancelHandler,
  contentCategoriesHandler,
  createCampaignHandler,
  deleteCreativeHandler,
  discardCampaignHandler,
  generateLandingPageHandler,
  getCampaignHandler,
  getCreativeHandler,
  getLandingPageHandler,
  interactionHandler,
  inventoryHandler,
  landingPageHandler,
  listCampaignsHandler,
  listLandingPagesHandler,
  patchLandingPageHandler,
  publishLandingPageHandler,
  unpublishLandingPageHandler,
  patchCampaignHandler,
  portfolioAnalyticsHandler,
  redemptionsHandler,
  requestCreativeChangesHandler,
  reviewCreativeHandler,
  reviewHandler,
  reviewQueueHandler,
  scanHandler,
  setCartHandler,
  submitForPaymentHandler,
  trackingCodeImageHandler,
  trackingCodesHandler,
  uploadCreativeHandler,
} from './campaigns.controller';

/**
 * Every route the booking flow needs, in the order the flow walks them.
 *
 * No `requireRole` anywhere: an advertiser and an agent both legitimately use
 * these, and which campaigns either may touch is decided per-campaign in the
 * service rather than per-route by a role. A role gate here would either lock
 * advertisers out of their own campaigns or let any agent open anybody's.
 */
export const campaignRouter = Router();

campaignRouter.use(authenticate);

/* G10: the kill switches. A campaign write is ordinary until it names a
 * second market (Q8) — that one is refused 503 FEATURE_OFF while
 * `campaigns.multi-market` is off; the service keeps its per-advertiser
 * 409 for the rollout rules. The landing-page builder and its review list
 * sit wholly behind `campaigns.landing-pages`. */
const multiMarketSwitch = requireFeatureWhen('campaigns.multi-market', (req) => Array.isArray(req.body?.targetMarkets) && req.body.targetMarkets.length > 1);
const landingPages = requireFeature('campaigns.landing-pages');

/* The analytics screen behind "see full analytics", with its search. Declared
   before /:id so "analytics" is never read as a campaign id. */
campaignRouter.get('/analytics', asyncHandler(portfolioAnalyticsHandler));

/* Lot D (Q44): the creative review desk — ADMIN, and declared before /:id so
   "creatives" is never read as a campaign id. The list contract: status
   chips with counts, plus kind, flagged, resubmitted and q. */
campaignRouter.get('/creatives/review-queue', requireRole('ADMIN'), asyncHandler(reviewQueueHandler));
campaignRouter.post('/creatives/review', requireRole('ADMIN'), asyncHandler(bulkReviewHandler));
campaignRouter.get('/creatives/:creativeId', requireRole('ADMIN'), asyncHandler(getCreativeHandler));
/* Lot D (Q138): the wizard's content-category question reads the seeded list. */
campaignRouter.get('/content-categories', asyncHandler(contentCategoriesHandler));
/* Lot E (Q106): the landing-page review list — ADMIN, and declared before /:id
   so "landing-pages" is never read as a campaign id. */
campaignRouter.get('/landing-pages', requireRole('ADMIN'), landingPages, asyncHandler(listLandingPagesHandler));

campaignRouter.get('/', asyncHandler(listCampaignsHandler));
campaignRouter.post('/', multiMarketSwitch, asyncHandler(createCampaignHandler));

campaignRouter.get('/:id', asyncHandler(getCampaignHandler));
campaignRouter.patch('/:id', multiMarketSwitch, asyncHandler(patchCampaignHandler));
campaignRouter.delete('/:id', asyncHandler(discardCampaignHandler));

campaignRouter.get('/:id/inventory', asyncHandler(inventoryHandler));
campaignRouter.put('/:id/spots', asyncHandler(setCartHandler));

campaignRouter.post('/:id/creatives', asyncHandler(uploadCreativeHandler));
campaignRouter.delete('/:id/creatives/:creativeId', asyncHandler(deleteCreativeHandler));
/* Lot D (Q44): ops' decision on one artwork. */
campaignRouter.patch('/:id/creatives/:creativeId/review', requireRole('ADMIN'), asyncHandler(reviewCreativeHandler));
/* Lot D (Q120): the advertiser's (or their agent's) answer to ADX-designed artwork. */
campaignRouter.post('/:id/creatives/:creativeId/accept', asyncHandler(acceptCreativeHandler));
campaignRouter.post('/:id/creatives/:creativeId/request-changes', asyncHandler(requestCreativeChangesHandler));

campaignRouter.get('/:id/review', asyncHandler(reviewHandler));
/* Lot C (Q88): ops or the agent send a prepared campaign to the advertiser to pay. */
campaignRouter.post('/:id/submit-for-payment', asyncHandler(submitForPaymentHandler));
campaignRouter.post('/:id/authorize', asyncHandler(authorizeHandler));
campaignRouter.post('/:id/cancel', asyncHandler(cancelHandler));

campaignRouter.get('/:id/analytics', asyncHandler(campaignAnalyticsHandler));
campaignRouter.get('/:id/tracking-codes', asyncHandler(trackingCodesHandler));
/* Lot D (Q139): the code's QR, drawn through the qr module, for the artwork to embed. */
campaignRouter.get('/:id/tracking-codes/:code/image.png', asyncHandler(trackingCodeImageHandler));
campaignRouter.post('/:id/redemptions', asyncHandler(redemptionsHandler));

/* Lot E (Q7/Q106): the landing-page builder. The advertiser or their agent
   draft it from the brief, edit the blocks, publish; ADX may take it down. */
campaignRouter.post('/:id/landing-page/generate', landingPages, asyncHandler(generateLandingPageHandler));
campaignRouter.get('/:id/landing-page', landingPages, asyncHandler(getLandingPageHandler));
campaignRouter.patch('/:id/landing-page', landingPages, asyncHandler(patchLandingPageHandler));
campaignRouter.post('/:id/landing-page/publish', landingPages, asyncHandler(publishLandingPageHandler));
campaignRouter.post('/:id/landing-page/unpublish', requireRole('ADMIN'), landingPages, asyncHandler(unpublishLandingPageHandler));

/**
 * The scan redirect, mounted at the application root rather than under
 * /api/v1/campaigns: it goes on a printed hoarding, and every character of a URL
 * a person might have to type matters.
 */
export const trackingRouter = Router();
trackingRouter.get('/t/:code', asyncHandler(scanHandler));
/* Lot D (Q7): what happened on the landing page after the scan. Public, metered by IP. */
trackingRouter.post('/t/:code/e', trackingInteractionLimiter, asyncHandler(interactionHandler));
/* Lot E (Q106): the page the scan lands on. Public; a slug nothing answers to
   falls through to the package payment link mounted after this router. */
trackingRouter.get('/p/:slug', asyncHandler(landingPageHandler));
