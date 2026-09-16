import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { spotPageLimiter } from '../../shared/security';
import { requireFeatureWhen } from '../feature-flags';
import {
  acceptSuggestedRateHandler,
  browseCategoriesHandler,
  browseListingHandler,
  browseListingsHandler,
  contentCategoriesHandler,
  createListingHandler,
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
  repriceLogHandler,
  spotPageHandler,
  submitListingHandler,
  listingAudienceHandler,
} from './listings.controller';

export const listingRouter = Router();
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
listingRouter.get('/browse', asyncHandler(browseListingsHandler));
/* G12-B: the category grid for the place. Above `/browse/:listingId` so
 * "categories" is never read as a listing id. */
listingRouter.get('/browse/categories', asyncHandler(browseCategoriesHandler));
listingRouter.get('/browse/:listingId', asyncHandler(browseListingHandler));
/* Lot D (Q5): the heart. Any signed-in advertiser, or their agent under a
 * live grant naming the advertiser — the handler resolves whose book the
 * save goes into and refuses a caller with none. */
listingRouter.put('/browse/:listingId/save', asyncHandler(saveListingHandler));
listingRouter.delete('/browse/:listingId/save', asyncHandler(unsaveListingHandler));

/* DR 10's review desk: everything at PENDING_REVIEW, with documents, photos and
 * the asking price against the rate-card floor. Above the parameterised routes
 * for the same reason as content-categories. */
listingRouter.get('/review', requireRole('ADMIN'), asyncHandler(reviewQueueHandler));

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

listingRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllListingsHandler));
/* PUBLISHER is here for the self-serve half of DR 02 — a publisher listing
 * their own spot from their own phone. The role only gets them through the
 * door: the handler resolves their publisher record from the login and ignores
 * any `publisherId` in the body, so it cannot be used to file a spot under
 * somebody else's account. */
listingRouter.post(
  '/',
  requireRole('AGENT_PUBLISHER', 'PUBLISHER', 'ADMIN'),
  instantBookingSwitch,
  asyncHandler(createListingHandler),
);
/* One spot, with its publisher, its agent and its photographs. Declared before
 * the PATCH on the same path so the router's order stays readable; the two do
 * not collide because they are different methods.
 *
 * ADMIN-only. A publisher reads their own spots through
 * `GET /publishers/me/listings`, and an advertiser reads a live one through
 * `/listings/browse/:listingId`; this is the desk's read, and it answers for a
 * listing in any state including the ones only ops should see. */
listingRouter.get('/:listingId', requireRole('ADMIN'), asyncHandler(getListingHandler));
/* E10-2: the Pricing tab's history as a first-class read — pricing's
 * LISTING_REPRICED_BY_FACTOR audit rows on this listing, shaped. */
listingRouter.get('/:listingId/reprice-log', requireRole('ADMIN'), asyncHandler(repriceLogHandler));

/* Ownership is checked in the handler, not by the role: an agent may edit the
 * listings of publishers they onboarded, plus any they have been lent through a
 * delegated access grant. See listings.service#assertCanEditListing. */
listingRouter.patch(
  '/:listingId',
  requireRole('AGENT_PUBLISHER', 'PUBLISHER', 'ADMIN'),
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

/* The desk's three verbs. The publisher's own verb is `/submit` above; these
 * are ADX's answers to it. `/publish` used to admit the publisher and their
 * agent too, which made the review optional — a spot could be submitted and
 * published by the same phone in the same minute, and the "within 24 hours"
 * promise on the confirmation screen was a promise ADX never got to keep. */
listingRouter.get('/:listingId/review', requireRole('ADMIN'), asyncHandler(reviewCaseHandler));
listingRouter.post(
  '/:listingId/send-back',
  requireRole('ADMIN'),
  asyncHandler(sendBackListingHandler),
);
listingRouter.post('/:listingId/publish', requireRole('ADMIN'), asyncHandler(publishListingHandler));

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
