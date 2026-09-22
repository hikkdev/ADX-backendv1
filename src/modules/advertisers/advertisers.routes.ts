import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { registerOnboardingRoutes } from './advertiser-onboarding.controller';
import {
  advertiserBookHandler,
  advertiserSummaryHandler,
  brandCardsHandler,
  brandDetailHandler,
  listAccountActivityHandler,
  recordAccountActivityHandler,
} from './book/book.controller';
import {
  acceptInsertionOrderHandler,
  acceptPlatformHandler,
  captureHoldHandler,
  createBrandHandler,
  decideRefundHandler,
  eligibilityHandler,
  expireCreditHandler,
  failRefundHandler,
  funnelHandler,
  funnelRowsHandler,
  getAdvertiserHandler,
  goodwillHandler,
  holdHandler,
  industriesHandler,
  kycDecisionHandler,
  listAdvertisersHandler,
  listRefundsHandler,
  listAdvertiserRefundRequestsHandler,
  listTopUpsHandler,
  markRefundPaidHandler,
  meHandler,
  refundDeskHandler,
  topUpDeskHandler,
  registerAdvertiserHandler,
  refundableHandler,
  releaseHoldHandler,
  requestRefundHandler,
  statementHandler,
  topUpHandler,
  updateBrandHandler,
  updateProfileHandler,
  walletHandler,
  withdrawRefundHandler,
  setAdvertiserBandHandler,
} from './advertisers.controller';

/**
 * Demand-side routes. Specification: docs/advertiser-onboarding.md.
 *
 * ROUTE ORDER IS LOAD-BEARING: `/funnel`, `/funnel/rows` and `/me` are all
 * registered before `/:id`, or Express matches them as advertiser ids and
 * answers 404 for the funnel the console renders and the profile the app
 * resolves itself with.
 *
 * Two things are deliberately ADMIN-only and worth stating, because both look
 * like they could be self-service:
 *
 *  - top-up, which will become a payment-gateway callback rather than an
 *    endpoint an advertiser can call to give themselves money;
 *  - goodwill credit, which is issued by the supply enforcement ladder and by
 *    nobody else.
 *
 * Accepting the platform agreement is NOT admin-only, and must not become so.
 * It is the advertiser's own click, exactly as the publisher's is.
 */
export const advertiserRouter = Router();
advertiserRouter.use(authenticate);

/* Funnel — before /:id */
advertiserRouter.get('/funnel', requireRole('ADMIN'), asyncHandler(funnelHandler));
advertiserRouter.get('/funnel/rows', requireRole('ADMIN'), asyncHandler(funnelRowsHandler));

/* The caller's own profile — before /:id, for the same reason as /funnel. */
advertiserRouter.get('/me', asyncHandler(meHandler));
/* Lot G (Q119): the industry picklist — any session, ahead of /:id. */
advertiserRouter.get('/industries', asyncHandler(industriesHandler));
// The door-to-door code and its approval — four literal /me/qr routes, ahead of /:id.
registerOnboardingRoutes(advertiserRouter);

// The agent's own book, on the list contract (DR 06). Declared before /:id
// so "mine" is never read as an id.
advertiserRouter.get('/mine', asyncHandler(advertiserBookHandler));


/* Agreement templates are `agreements`' — /agreements/templates. The legacy
   GET/POST /advertisers/agreements/templates pair is retired (Lot D). */

/* Refund requests. Raised by support, decided by a different admin — the
   service refuses a decision from whoever raised it. Listed before /:id. */
advertiserRouter.get('/refund-requests', requireRole('ADMIN'), asyncHandler(listRefundsHandler));
advertiserRouter.patch('/refund-requests/:requestId/decide', requireRole('ADMIN'), asyncHandler(decideRefundHandler));
advertiserRouter.patch('/refund-requests/:requestId/withdraw', requireRole('ADMIN'), asyncHandler(withdrawRefundHandler));
/* Lot B (Q41): finance paying an approved bank-transfer refund, or recording
   that the transfer bounced. Money out, so `finance.approve` on top of ADMIN. */
advertiserRouter.post('/refund-requests/:requestId/mark-paid', requireRole('ADMIN'), requirePermission('finance.approve'), asyncHandler(markRefundPaidHandler));
advertiserRouter.post('/refund-requests/:requestId/fail', requireRole('ADMIN'), requirePermission('finance.approve'), asyncHandler(failRefundHandler));

/* Sweeps dormant credit. Idempotent, so a scheduler can run it freely. */
advertiserRouter.post('/wallet/expire-credit', requireRole('ADMIN'), asyncHandler(expireCreditHandler));

/* Accounts */
advertiserRouter.get('/', requireRole('ADMIN'), asyncHandler(listAdvertisersHandler));
advertiserRouter.post('/', asyncHandler(registerAdvertiserHandler));
advertiserRouter.get('/:id', asyncHandler(getAdvertiserHandler));
advertiserRouter.patch('/:id', asyncHandler(updateProfileHandler));
// AG-5: the importance band — the agent grade's axis — set by the desk alone.
advertiserRouter.patch('/:id/band', requireRole('ADMIN'), asyncHandler(setAdvertiserBandHandler));
advertiserRouter.get('/:id/eligibility', asyncHandler(eligibilityHandler));
advertiserRouter.patch('/:id/kyc', requireRole('ADMIN'), asyncHandler(kycDecisionHandler));

/* Agreements */
advertiserRouter.post('/:id/agreements/platform', asyncHandler(acceptPlatformHandler));
advertiserRouter.post('/:id/agreements/insertion-order', asyncHandler(acceptInsertionOrderHandler));

/* The detail card the agent app draws, and the account's action log (DR 06). */
advertiserRouter.get('/:id/summary', asyncHandler(advertiserSummaryHandler));
advertiserRouter.get('/:id/activity', asyncHandler(listAccountActivityHandler));
advertiserRouter.post('/:id/activity', asyncHandler(recordAccountActivityHandler));

/* Brands — cards with their campaign counts and lifetime spend; `?status=ARCHIVED` is the third chip. */
advertiserRouter.get('/:id/brands', asyncHandler(brandCardsHandler));
advertiserRouter.post('/:id/brands', asyncHandler(createBrandHandler));
advertiserRouter.get('/:id/brands/:brandId', asyncHandler(brandDetailHandler));
advertiserRouter.patch('/:id/brands/:brandId', asyncHandler(updateBrandHandler));

/* Wallet */
advertiserRouter.get('/:id/wallet', asyncHandler(walletHandler));
advertiserRouter.get('/:id/wallet/statement', asyncHandler(statementHandler));
advertiserRouter.post('/:id/wallet/top-up', requireRole('ADMIN'), asyncHandler(topUpHandler));
advertiserRouter.get('/:id/wallet/top-ups', asyncHandler(listTopUpsHandler));
advertiserRouter.post('/:id/wallet/goodwill', requireRole('ADMIN'), asyncHandler(goodwillHandler));
advertiserRouter.get('/:id/wallet/refundable', requireRole('ADMIN'), asyncHandler(refundableHandler));
advertiserRouter.post('/:id/wallet/refund-requests', requireRole('ADMIN'), asyncHandler(requestRefundHandler));
/* E6: the advertiser's own requests — owner or their agent, on the list contract. */
advertiserRouter.get('/:id/wallet/refund-requests', asyncHandler(listAdvertiserRefundRequestsHandler));
advertiserRouter.post('/:id/wallet/holds', asyncHandler(holdHandler));
advertiserRouter.post('/:id/wallet/holds/:holdId/capture', requireRole('ADMIN'), asyncHandler(captureHoldHandler));
advertiserRouter.post('/:id/wallet/holds/:holdId/release', asyncHandler(releaseHoldHandler));

/**
 * The refund desk's queue (Lot B, Q41), mounted at /finance/refund-requests
 * beside the payouts finance router. Its own router because the finance
 * prefix belongs to `payouts`, and this list is a view over a table this
 * module owns.
 */
export const refundDeskRouter = Router();
refundDeskRouter.use(authenticate);
refundDeskRouter.get('/', requireRole('ADMIN'), asyncHandler(refundDeskHandler));

/**
 * E6: the top-up register, mounted at /finance/top-ups for the same reason —
 * the finance prefix is `payouts`', the table is this module's.
 */
export const topUpDeskRouter = Router();
topUpDeskRouter.use(authenticate);
topUpDeskRouter.get('/', requireRole('ADMIN'), asyncHandler(topUpDeskHandler));
