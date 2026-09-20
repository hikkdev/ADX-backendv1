import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
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
} from './supply.controller';

export const supplyRouter = Router();
supplyRouter.use(authenticate);

/* Funnel — the supply-acquisition dashboard. */
supplyRouter.get('/funnel', requireRole('ADMIN'), asyncHandler(funnelHandler));
supplyRouter.get('/funnel/publishers', requireRole('ADMIN'), asyncHandler(funnelPublishersHandler));

/* Agreement templates are `agreements`' — /agreements/templates. The legacy
   GET/POST /supply/agreements/templates pair is retired (Lot D). */

/* Acceptance. A publisher accepts for themselves; admin accepts on their
   behalf only where an agent or ops built the listing. */
supplyRouter.post(
  '/agreements/accept-platform',
  requireRole('PUBLISHER', 'ADMIN'),
  asyncHandler(acceptPlatformHandler),
);
supplyRouter.post(
  '/agreements/accept-listing',
  requireRole('PUBLISHER', 'ADMIN'),
  asyncHandler(acceptListingHandler),
);

/* Listing attempts — the batch a listing agreement attaches to. */
supplyRouter.get('/attempts', requireRole('ADMIN'), asyncHandler(listAttemptsHandler));
supplyRouter.post(
  '/attempts',
  requireRole('ADMIN', 'AGENT_PUBLISHER'),
  asyncHandler(createAttemptHandler),
);
supplyRouter.get(
  '/attempts/:attemptId',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER'),
  asyncHandler(getAttemptHandler),
);
supplyRouter.post(
  '/attempts/:attemptId/listings',
  requireRole('ADMIN', 'AGENT_PUBLISHER'),
  asyncHandler(addListingsHandler),
);
supplyRouter.post(
  '/attempts/:attemptId/request-acceptance',
  requireRole('ADMIN', 'AGENT_PUBLISHER'),
  asyncHandler(requestAcceptanceHandler),
);

/* Per-listing documents. Desk review gates the site visit. */
// A12: the milestone queue dispatches site visits to advertiser-side agents
// too, and the visit files here — so both agent roles are admitted. The
// review stays ADMIN.
supplyRouter.get(
  '/listings/:listingId/documents',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'),
  asyncHandler(listDocumentsHandler),
);
supplyRouter.post(
  '/listings/:listingId/documents',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'),
  asyncHandler(submitDocumentHandler),
);
supplyRouter.patch(
  '/documents/:documentId/review',
  requireRole('ADMIN'),
  asyncHandler(reviewDocumentHandler),
);

/* Verification. AGENT_INITIAL comes from the field, SELF_REVERIFICATION from
   the publisher's own GPS camera. */
supplyRouter.get(
  '/listings/:listingId/verifications',
  requireRole('ADMIN', 'PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'),
  asyncHandler(listVerificationsHandler),
);
supplyRouter.post(
  '/listings/:listingId/verifications',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'ADMIN'),
  asyncHandler(submitVerificationHandler),
);
supplyRouter.patch(
  '/verifications/:verificationId/review',
  requireRole('ADMIN'),
  asyncHandler(reviewVerificationHandler),
);
supplyRouter.get('/verification-queue', requireRole('ADMIN'), asyncHandler(verificationQueueHandler));

/* QR-24: the right to sell a space and its term. The publisher sets their
   own; an agent or ADX any. The desk's queue and the on-demand sweep are ADX's. */
supplyRouter.patch('/listings/:listingId/rights', requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'), asyncHandler(setRightsHandler));
supplyRouter.get('/rights-queue', requireRole('ADMIN'), asyncHandler(rightsQueueHandler));
supplyRouter.post('/rights/sweep', requireRole('ADMIN'), asyncHandler(rightsSweepHandler));

/* Enforcement sweep. Idempotent, intended for a scheduler; exposed so ops can
   run it on demand while there is no job runner. */
supplyRouter.post(
  '/enforcement/sweep',
  requireRole('ADMIN'),
  asyncHandler(enforcementSweepHandler),
);

/* Claims on unowned, scraped inventory. */
supplyRouter.get('/claims', requireRole('ADMIN'), asyncHandler(listClaimsHandler));
supplyRouter.post(
  '/claims',
  requireRole('PUBLISHER', 'AGENT_PUBLISHER', 'ADMIN'),
  asyncHandler(createClaimHandler),
);
supplyRouter.patch('/claims/:claimId/decide', requireRole('ADMIN'), asyncHandler(decideClaimHandler));

/* Compliance cases opened three days into a lapse. */
supplyRouter.get('/compliance/cases', requireRole('ADMIN'), asyncHandler(listCasesHandler));
supplyRouter.post(
  '/compliance/cases/:caseId/attempts',
  requireRole('ADMIN'),
  asyncHandler(contactAttemptHandler),
);
supplyRouter.patch(
  '/compliance/cases/:caseId/resolve',
  requireRole('ADMIN'),
  asyncHandler(resolveCaseHandler),
);
