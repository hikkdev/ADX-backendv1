import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  acceptListingHandler,
  acceptPlatformHandler,
  addListingsHandler,
  contactAttemptHandler,
  createAttemptHandler,
  createClaimHandler,
  decideClaimHandler,
  enforcementSweepHandler,
  funnelHandler,
  funnelPublishersHandler,
  getAttemptHandler,
  listAttemptsHandler,
  listCasesHandler,
  listClaimsHandler,
  listDocumentsHandler,
  listVerificationsHandler,
  requestAcceptanceHandler,
  resolveCaseHandler,
  reviewDocumentHandler,
  reviewVerificationHandler,
  submitDocumentHandler,
  submitVerificationHandler,
  verificationQueueHandler,
  setRightsHandler,
  rightsQueueHandler,
  rightsSweepHandler,
  remindRightsHandler,
  remindReverificationHandler,
  extendReverificationHandler,
  siteCheckHandler,
} from './supply.controller';

export const supplyRouter = Router();
supplyRouter.use(authenticate);

/* Funnel — the supply-acquisition dashboard. */
supplyRouter.get('/funnel', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(funnelHandler));
supplyRouter.get('/funnel/publishers', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(funnelPublishersHandler));

/* Agreement templates are `agreements`' — /agreements/templates. The legacy
   GET/POST /supply/agreements/templates pair is retired (Lot D). */

/* Acceptance. A publisher accepts for themselves; admin accepts on their
   behalf only where an agent or ops built the listing. */
supplyRouter.post(
  '/agreements/accept-platform',
  requireRole('PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(acceptPlatformHandler),
);
supplyRouter.post(
  '/agreements/accept-listing',
  requireRole('PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(acceptListingHandler),
);

/* Listing attempts — the batch a listing agreement attaches to. */
supplyRouter.get('/attempts', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(listAttemptsHandler));
supplyRouter.post(
  '/attempts',
  requireRole('ADMIN', 'AGENT_PUBLISHER'), requirePermission('supply.edit'),
  asyncHandler(createAttemptHandler),
);
supplyRouter.get(
  '/attempts/:attemptId',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'), requirePermission('supply.view'),
  asyncHandler(getAttemptHandler),
);
supplyRouter.post(
  '/attempts/:attemptId/listings',
  requireRole('ADMIN', 'AGENT_PUBLISHER'), requirePermission('supply.edit'),
  asyncHandler(addListingsHandler),
);
supplyRouter.post(
  '/attempts/:attemptId/request-acceptance',
  requireRole('ADMIN', 'AGENT_PUBLISHER'), requirePermission('supply.edit'),
  asyncHandler(requestAcceptanceHandler),
);

/* Per-listing documents. Desk review gates the site visit. */
// A12: the milestone queue dispatches site visits to advertiser-side agents
// too, and the visit files here — so both agent roles are admitted. The
// review stays ADMIN.
supplyRouter.get(
  '/listings/:listingId/documents',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'), requirePermission('supply.view'),
  asyncHandler(listDocumentsHandler),
);
supplyRouter.post(
  '/listings/:listingId/documents',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(submitDocumentHandler),
);
supplyRouter.patch(
  '/documents/:documentId/review',
  requireRole('ADMIN'), requirePermission('supply.approve'),
  asyncHandler(reviewDocumentHandler),
);

/* Verification. AGENT_INITIAL comes from the field, SELF_REVERIFICATION from
   the publisher's own GPS camera. */
supplyRouter.get(
  '/listings/:listingId/verifications',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'), requirePermission('supply.view'),
  asyncHandler(listVerificationsHandler),
);
supplyRouter.post(
  '/listings/:listingId/verifications',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(submitVerificationHandler),
);
supplyRouter.patch(
  '/verifications/:verificationId/review',
  requireRole('ADMIN'), requirePermission('supply.approve'),
  asyncHandler(reviewVerificationHandler),
);
supplyRouter.get('/verification-queue', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(verificationQueueHandler));

/* 3 Oct 2026 — what the verification queue can do about a lapse: remind the
   publisher (once a day, the audit trail the clock), send an agent (a field
   visit through `visits`), give more time (moves the due date, lifts the
   earnings pause until it). Suspend / Reinstate stay the suspension
   module's (`/listings/:id/suspend`). Nothing here marks a spot verified. */
supplyRouter.post(
  '/listings/:listingId/reverification/remind',
  requireRole('ADMIN'), requirePermission('supply.edit'),
  asyncHandler(remindReverificationHandler),
);
supplyRouter.post(
  '/listings/:listingId/reverification/site-check',
  requireRole('ADMIN'), requirePermission('supply.edit'),
  asyncHandler(siteCheckHandler),
);
supplyRouter.post(
  '/listings/:listingId/reverification/extend',
  requireRole('ADMIN'), requirePermission('supply.approve'),
  asyncHandler(extendReverificationHandler),
);

/* QR-24: the right to sell a space and its term. The publisher sets their
   own; an agent or ADX any. The desk's queue and the on-demand sweep are ADX's. */
supplyRouter.patch('/listings/:listingId/rights', requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'), asyncHandler(setRightsHandler));
/* 3 Oct 2026 — the renewals desk's "Remind publisher to renew": once a day per listing, the audit trail the clock. */
supplyRouter.post('/listings/:listingId/rights/remind', requireRole('ADMIN'), requirePermission('supply.edit'), asyncHandler(remindRightsHandler));
supplyRouter.get('/rights-queue', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(rightsQueueHandler));
supplyRouter.post('/rights/sweep', requireRole('ADMIN'), requirePermission('system.jobs'), asyncHandler(rightsSweepHandler));

/* Enforcement sweep. Idempotent, intended for a scheduler; exposed so ops can
   run it on demand while there is no job runner. */
supplyRouter.post(
  '/enforcement/sweep',
  requireRole('ADMIN'), requirePermission('system.jobs'),
  asyncHandler(enforcementSweepHandler),
);

/* Claims on unowned, scraped inventory. */
supplyRouter.get('/claims', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(listClaimsHandler));
supplyRouter.post(
  '/claims',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'),
  asyncHandler(createClaimHandler),
);
supplyRouter.patch('/claims/:claimId/decide', requireRole('ADMIN'), requirePermission('supply.approve'), asyncHandler(decideClaimHandler));

/* Compliance cases opened three days into a lapse. */
supplyRouter.get('/compliance/cases', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(listCasesHandler));
supplyRouter.post(
  '/compliance/cases/:caseId/attempts',
  requireRole('ADMIN'), requirePermission('supply.edit'),
  asyncHandler(contactAttemptHandler),
);
supplyRouter.patch(
  '/compliance/cases/:caseId/resolve',
  requireRole('ADMIN'), requirePermission('supply.approve'),
  asyncHandler(resolveCaseHandler),
);
