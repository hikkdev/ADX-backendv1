import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, authenticateOptional, requireRole, requirePermission } from '../../shared/auth';
import { publicReadLimiter, spotPageLimiter, spotViewLimiter } from '../../shared/security';
import { requireFeature, requireFeatureWhen } from '../feature-flags';
import {
  acceptSuggestedRateHandler,
  browseCategoriesHandler,
  browseVenuesHandler,
  browseListingHandler,
  listingAvailabilityHandler,
  browseListingsHandler,
  contentCategoriesHandler,
  createListingHandler,
  deleteListingDraftHandler,
  deskListingDraftHandler,
  deskListingDraftsHandler,
  deleteDeskListingDraftHandler,
  listMyListingDraftsHandler,
  saveListingDraftHandler,
  getAllListingsHandler,
  listingContentRulesHandler,
  getListingHandler,
  reviewCaseHandler,
  reviewQueueHandler,
  saveListingHandler,
  savedListingsHandler,
  sendBackListingHandler,
  suggestedRateHandler,
  unsaveListingHandler,
  updateListingHandler,
  publishListingHandler,
  checkVehicleRcHandler,
  verifyListingVehicleRcHandler,
  repriceLogHandler,
  spotPageHandler,
  submitListingHandler,
  listingAudienceHandler,
  listingInsightsHandler,
  listingViewHandler,
} from './listings.controller';
import { addBlockedDateHandler, listBlockedDatesHandler, removeBlockedDateHandler } from './blocked-dates.controller';
import { addListingPhotoHandler, listingClarificationHandler, removeListingPhotoHandler } from './listings.controller';

export const listingRouter = Router();

/* W1 (24 Sep 2026): discovery is public. The website's Explore page and a
 * spot's page answer a visitor with no session; a session personalises them
 * (the saved hearts, the caller's advertiser). Registered above the
 * router-wide authenticate, and above the parameterised routes so "browse"
 * is never read as a listing id. The heart itself stays a signed-in write. */
listingRouter.get('/browse', authenticateOptional, asyncHandler(browseListingsHandler));
listingRouter.get('/browse/categories', authenticateOptional, asyncHandler(browseCategoriesHandler));
listingRouter.get('/browse/venues', authenticateOptional, asyncHandler(browseVenuesHandler));
listingRouter.get('/browse/:listingId', authenticateOptional, asyncHandler(browseListingHandler));
/* AV-1 (27 Sep 2026): the per-day picture of one space — booked, partly booked, free — and the next dates that fit. */
listingRouter.get('/browse/:listingId/availability', publicReadLimiter, authenticateOptional, asyncHandler(listingAvailabilityHandler));
/* LD-1 (3 Oct 2026): a spot's page was opened — the website's spot page and
 * marketplace detail, the app's listing screen. Public (a visitor has no
 * session), metered per caller, behind its own kill switch; a session only
 * lets the count leave out the spot's own people and ADX. */
listingRouter.post(
  '/:displayIdOrId/view',
  authenticateOptional,
  spotViewLimiter,
  requireFeature('listings.spot-views'),
  asyncHandler(listingViewHandler),
);

listingRouter.use(authenticate);

/* G10: the kill switch on instant booking (Q6). A listing write is an
 * ordinary write until it opts the spot into automatic acceptance; that one
 * is refused 503 FEATURE_OFF while `marketplace.instant-booking` is off. The
 * service keeps its per-publisher 409 for the rollout rules. */
const instantBookingSwitch = requireFeatureWhen('marketplace.instant-booking', (req) => req.body?.instantBooking === true);

/* Reference data the listing form needs, on every client. Registered above the
 * parameterised routes below so "content-categories" is never read as a
 * listing id. */
listingRouter.get('/content-categories', asyncHandler(contentCategoriesHandler));

/* DR 01's advertiser discovery: ACTIVE spots by the filter drawer's facets,
 * and one spot's page. Any signed-in account may look — an advertiser still
 * in KYC review is told they can browse and see prices, and an agent on the
 * advertiser side sells from the same list. Above the parameterised routes
 * so "browse" is never read as a listing id. */
/* The four browse reads are registered above, before `authenticate`, since W1. */
/* Lot D (Q5): the heart. Any signed-in advertiser, or their agent under a
 * live grant naming the advertiser — the handler resolves whose book the
 * save goes into and refuses a caller with none. */
listingRouter.put('/browse/:listingId/save', asyncHandler(saveListingHandler));
listingRouter.delete('/browse/:listingId/save', asyncHandler(unsaveListingHandler));

/* DR 10's review desk: everything at PENDING_REVIEW, with documents, photos and
 * the asking price against the rate-card floor. Above the parameterised routes
 * for the same reason as content-categories. */
listingRouter.get('/review', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(reviewQueueHandler));

/* Lot E: the publisher's side of pricing factors. The offer ADX's applied
 * ADVISORY factors make on their spot, and the tap that takes it — written
 * as the publisher's own decision through the ordinary update. The role only
 * gets them through the door; ownership (the publisher, their agent, or an
 * agent under a live grant) is `assertCanEditListing` in the handler. */
listingRouter.get(
  '/me/:listingId/suggested-rate',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(suggestedRateHandler),
);
listingRouter.post(
  '/me/:listingId/accept-suggested-rate',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(acceptSuggestedRateHandler),
);

listingRouter.get('/', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(getAllListingsHandler));
/* PUBLISHER is here for the self-serve half of DR 02 — a publisher listing
 * their own spot from their own phone. The role only gets them through the
 * door: the handler resolves their publisher record from the login and ignores
 * any `publisherId` in the body, so it cannot be used to file a spot under
 * somebody else's account. */
/* QR-8: listing drafts — the publisher's own, saved half-way to finish
   later, and the desk's view of every publisher's. Registered before
   `/:listingId` so "drafts" is never read as an id. */
listingRouter.get('/drafts/desk', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(deskListingDraftsHandler));
/* 2 Oct 2026: the Listings table's draft rows — open one, or throw it away. */
listingRouter.get('/drafts/desk/:draftId', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(deskListingDraftHandler));
listingRouter.delete('/drafts/desk/:draftId', requireRole('ADMIN'), requirePermission('marketplace.delete'), asyncHandler(deleteDeskListingDraftHandler));
listingRouter.get('/drafts', requireRole('PUBLISHER'), asyncHandler(listMyListingDraftsHandler));
listingRouter.post('/drafts', requireRole('PUBLISHER'), asyncHandler(saveListingDraftHandler));
listingRouter.put('/drafts/:draftId', requireRole('PUBLISHER'), asyncHandler(saveListingDraftHandler));
listingRouter.delete('/drafts/:draftId', requireRole('PUBLISHER'), asyncHandler(deleteListingDraftHandler));

listingRouter.post(
  '/',
  requireRole('AGENT_PUBLISHER', 'PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  instantBookingSwitch,
  asyncHandler(createListingHandler),
);
/* VH-3: the Verify button beside the registration field, while the spot is
 * still being registered and there is no listing yet to check against.
 *
 * Declared HERE, above every `/:listingId` route, because `vehicle-rc` would
 * otherwise be read as a listing id — Express matches in declaration order,
 * and a literal path below a parameter is a route that never runs. */
listingRouter.post(
  '/vehicle-rc/check',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'), requirePermission('supply.edit'),
  asyncHandler(checkVehicleRcHandler),
);
/* One spot, with its publisher, its agent and its photographs. Declared before
 * the PATCH on the same path so the router's order stays readable; the two do
 * not collide because they are different methods.
 *
 * ADMIN-only. A publisher reads their own spots through
 * `GET /publishers/me/listings`, and an advertiser reads a live one through
 * `/listings/browse/:listingId`; this is the desk's read, and it answers for a
 * listing in any state including the ones only ops should see. */
listingRouter.get('/:listingId', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(getListingHandler));
/* E10-2: the Pricing tab's history as a first-class read — pricing's
 * LISTING_REPRICED_BY_FACTOR audit rows on this listing, shaped. */
listingRouter.get('/:listingId/reprice-log', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(repriceLogHandler));
/* 3 Oct 2026: the listing page's Performance — saves, bookings, enquiries,
 * scans, GMV, occupancy and the stars over a window, with the day series. */
listingRouter.get('/:listingId/insights', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(listingInsightsHandler));

/* Ownership is checked in the handler, not by the role: an agent may edit the
 * listings of publishers they onboarded, plus any they have been lent through a
 * delegated access grant. See listings.service#assertCanEditListing. */
listingRouter.patch(
  '/:listingId',
  requireRole('AGENT_PUBLISHER', 'PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  instantBookingSwitch,
  asyncHandler(updateListingHandler),
);
listingRouter.get('/:listingId/content-rules', asyncHandler(listingContentRulesHandler));
/* G7 (Q109): the vendor's audience panel for the spot's catchment. Any role
 * through the door; the service admits ADX, the publisher's side, or an
 * advertiser who has the spot in a campaign. */
listingRouter.get('/:listingId/audience', asyncHandler(listingAudienceHandler));
listingRouter.post(
  '/:listingId/submit',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(submitListingHandler),
);

/* BD-1 (DR 12): the dates the publisher takes the spot off the market. The
 * role is the outer fence; ownership is `assertCanEditListing` in the
 * service (the publisher, their agent, an agent under a live grant), and
 * the desk reads or edits under supply's own powers. A block is the
 * publisher's own record, so its DELETE is judged by ownership, not a
 * delete power (see tests/contract/admin-routes-need-permission). */
listingRouter.get(
  '/:listingId/blocked-dates',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.view'),
  asyncHandler(listBlockedDatesHandler),
);
listingRouter.post(
  '/:listingId/blocked-dates',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(addBlockedDateHandler),
);
listingRouter.delete(
  '/:listingId/blocked-dates/:blockId',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(removeBlockedDateHandler),
);

/* WG-1 (DR 12 board 09): photographs on a live listing, and (board 08 · 26)
 * the publisher's written word back on a send-back. Ownership as an edit. */
listingRouter.post(
  '/:listingId/photos',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(addListingPhotoHandler),
);
listingRouter.delete(
  '/:listingId/photos/:photoId',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(removeListingPhotoHandler),
);
listingRouter.post(
  '/:listingId/clarification',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(listingClarificationHandler),
);

/* The desk's three verbs. The publisher's own verb is `/submit` above; these
 * are ADX's answers to it. `/publish` used to admit the publisher and their
 * agent too, which made the review optional — a spot could be submitted and
 * published by the same phone in the same minute, and the "within 24 hours"
 * promise on the confirmation screen was a promise ADX never got to keep. */
listingRouter.get('/:listingId/review', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(reviewCaseHandler));
listingRouter.post(
  '/:listingId/send-back',
  requireRole('ADMIN'), requirePermission('supply.approve'),
  asyncHandler(sendBackListingHandler),
);
listingRouter.post('/:listingId/publish', requireRole('ADMIN'), requirePermission('supply.approve'), asyncHandler(publishListingHandler));
/* AG-4 / VH-1: a vehicle put up as a spot — its RC checked with Cashfree's
 * lookup. The desk may; so may the spot's own publisher and the agent
 * registering it, which is where the number is actually typed. The service
 * checks ownership before the lookup runs, so the role here is the outer
 * fence and not the whole gate. */
listingRouter.post(
  '/:listingId/vehicle-rc/verify',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'), requirePermission('supply.edit'),
  asyncHandler(verifyListingVehicleRcHandler),
);

/**
 * Lot D (Q5): the advertiser's saved spaces, under their account but owned
 * here because a saved space is a listing read. Mounted by bootstrap at
 * /advertisers ahead of advertiserRouter, with its own authenticate, so the
 * request is authenticated once; the party policy is `assertMayActFor`.
 */
export const savedSpacesRouter = Router();
savedSpacesRouter.get('/:advertiserId/saved', authenticate, asyncHandler(savedListingsHandler));

/**
 * E11-2: the public spot page. Mounted at the application root beside the
 * scan redirect and the landing page, for the same reason: it is the link
 * an advertiser shares with somebody who may have no account and no app,
 * and it opens on any phone. Public, metered by IP; ACTIVE listings only.
 */
export const spotPageRouter = Router();
spotPageRouter.get('/s/:displayId', spotPageLimiter, asyncHandler(spotPageHandler));
