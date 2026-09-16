import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { packageLinkLimiter } from '../../shared/security/rate-limit';
import {
  acceptTermsHandler,
  activePackageHandler,
  cancelHandler,
  catalogueHandler,
  createAddOnHandler,
  getSaleHandler,
  listSalesHandler,
  payHandler,
  publicLinkHandler,
  quoteHandler,
  recordPaymentHandler,
  resendHandler,
  sellHandler,
  setAutoRenewHandler,
  startTrialHandler,
  updateAddOnHandler,
  updatePlanHandler,
} from './packages.controller';

/**
 * The four screens, in the order they are walked.
 *
 * Who may do what is decided per sale in the service rather than per route by a
 * role, for the same reason campaigns are: an advertiser and their agent both
 * legitimately use these, and a role gate here would either lock advertisers out
 * of their own plan or let any agent read anybody's.
 *
 * The one exception is recording an offline payment, which is admin-only —
 * marking money received that nobody can see arriving is not a field action.
 */
export const packageRouter = Router();

packageRouter.use(authenticate);

/* Steps 1 and 2: the catalogue, then what a choice costs. */
packageRouter.get('/catalogue', asyncHandler(catalogueHandler));
/* Lot D (Q94): the catalogue editor. Sales keep their snapshot; entitlements
   stay copy. ADMIN, audited in the service. */
packageRouter.patch('/catalogue/plans/:tier', requireRole('ADMIN'), asyncHandler(updatePlanHandler));
packageRouter.post('/catalogue/add-ons', requireRole('ADMIN'), asyncHandler(createAddOnHandler));
packageRouter.patch('/catalogue/add-ons/:code', requireRole('ADMIN'), asyncHandler(updateAddOnHandler));
packageRouter.post('/quote', asyncHandler(quoteHandler));

/* The advertiser's own live plan. Declared before /:id so it is not read as one. */
packageRouter.get('/active', asyncHandler(activePackageHandler));
/* Lot J2 (6): the advertiser's auto-renew switch on their running plan. */
packageRouter.patch('/active', asyncHandler(setAutoRenewHandler));

packageRouter.get('/sales', asyncHandler(listSalesHandler));

/* Step 3: create the sale and send the link. Both of these put a message on
 * somebody's handset, so both are metered. */
packageRouter.post('/sales', packageLinkLimiter, asyncHandler(sellHandler));
/* Lot J2 (5): the free trial — declared before `/sales/:id` so `trial` is never taken for a sale id. */
packageRouter.post('/sales/trial', asyncHandler(startTrialHandler));

packageRouter.get('/sales/:id', asyncHandler(getSaleHandler));
packageRouter.post('/sales/:id/resend', packageLinkLimiter, asyncHandler(resendHandler));
packageRouter.post('/sales/:id/cancel', asyncHandler(cancelHandler));
/* Lot D (Q123): the package terms, accepted by the advertiser or their agent
   under a grant, before either payment door opens. */
packageRouter.post('/sales/:id/accept-terms', asyncHandler(acceptTermsHandler));

/* Step 4 arrives one of two ways: the advertiser pays, or ops records that they did. */
packageRouter.post('/sales/:id/pay', asyncHandler(payHandler));
packageRouter.post(
  '/sales/:id/record-payment',
  requireRole('ADMIN'),
  asyncHandler(recordPaymentHandler)
);

/**
 * What the payment link opens.
 *
 * Mounted at the application root beside the campaign scan redirect, and for the
 * same reason: it goes out over SMS, where every character is one somebody may
 * have to read off a screen and type.
 */
export const packageLinkRouter = Router();
packageLinkRouter.get('/p/:token', asyncHandler(publicLinkHandler));
