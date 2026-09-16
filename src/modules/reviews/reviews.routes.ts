import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { requireFeature } from '../feature-flags';
import {
  agentReviewsHandler,
  hideReviewHandler,
  listReviewsHandler,
  listingReviewsHandler,
  myAgentReviewsHandler,
  rateAgentEligibilityHandler,
  rateAgentHandler,
  reviewSpotHandler,
  unhideReviewHandler,
} from './reviews.controller';

/**
 * The reviews module's routes, in two routers.
 *
 * `reviewPartyRouter` hangs its paths off the parties a review belongs to —
 * a campaign's spot, a listing's page, an order, an agent — and is mounted
 * by bootstrap on the API router root AHEAD of those modules' routers, the
 * way `suspension` is: a request for `/campaigns/:id/spots/:spotId/review`
 * would otherwise enter `campaignRouter`, be authenticated there, and fall
 * out the bottom. Each route carries its own `authenticate`, so nothing
 * under `/campaigns` or `/orders` is authenticated twice and nothing here
 * is open. `reviewRouter` is the desk, under `/reviews`.
 */
export const reviewPartyRouter = Router();

/* G10: the kill switch on reviews — every route of both routers, behind
 * authenticate so a rollout by role sees the token. */
const reviews = requireFeature('marketplace.reviews');

/* Q104: the campaign's advertiser reviews a spot that ran to the end. Who
 * may act is decided in the service through `campaigns.assertMayAct`, not
 * by a role — the same reason the campaign routes carry none. */
reviewPartyRouter.post('/campaigns/:id/spots/:spotId/review', authenticate, reviews, asyncHandler(reviewSpotHandler));

/* The listing page's reviews: PUBLISHED only, any signed-in caller — the
 * same door `/listings/browse/:id` opens to. */
reviewPartyRouter.get('/listings/browse/:listingId/reviews', authenticate, reviews, asyncHandler(listingReviewsHandler));

/* Q112: the publisher rates the agent. Ownership of the order's listing is
 * checked in the service; the role only gets them through the door. */
reviewPartyRouter.get(
  '/orders/:id/rate-agent/eligibility',
  authenticate,
  requireRole('PUBLISHER', 'AGENT_PUBLISHER'),
  reviews,
  asyncHandler(rateAgentEligibilityHandler),
);
reviewPartyRouter.post(
  '/orders/:id/rate-agent',
  authenticate,
  requireRole('PUBLISHER', 'AGENT_PUBLISHER'),
  reviews,
  asyncHandler(rateAgentHandler),
);

/* E7-2: the agent's own stars — PUBLISHED only, on the list contract, the
 * publisher never named. Declared AHEAD of the desk's /agents/:id/reviews so
 * "me" is never read as an id, and mounted ahead of agentRouter by bootstrap
 * like the rest of this router. */
reviewPartyRouter.get(
  '/agents/me/reviews',
  authenticate,
  requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'),
  reviews,
  asyncHandler(myAgentReviewsHandler),
);

/* The desk's view of one agent's stars, hidden ones included. */
reviewPartyRouter.get('/agents/:id/reviews', authenticate, requireRole('ADMIN'), reviews, asyncHandler(agentReviewsHandler));

/**
 * The desk. Hiding is moderation, so it sits behind `content.approve` on top
 * of the ADMIN role; every write is audited by hand with the status diff.
 */
export const reviewRouter = Router();
reviewRouter.use(authenticate, requireRole('ADMIN'), reviews);
reviewRouter.get('/', asyncHandler(listReviewsHandler));
reviewRouter.patch('/:id/hide', requirePermission('content.approve'), asyncHandler(hideReviewHandler));
reviewRouter.patch('/:id/unhide', requirePermission('content.approve'), asyncHandler(unhideReviewHandler));
