import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, authenticateOptional, requirePermission, requireRole } from '../../shared/auth';
import { publicReadLimiter } from '../../shared/security';
import {
  createPublisherHandler,
  getPublishersHandler,
  getPublisherHandler,
  updatePublisherHandler,
  submitKycHandler,
  reviewKycHandler,
  getOnboardingStatusHandler,
  getPublisherListingsHandler,
  kycQueueHandler,
  escalateKycCaseHandler,
  kycCaseHandler,
  restartDigioKycHandler,
  reviewKycDocumentHandler,
  requestKycReuploadHandler,
  assignKycCaseHandler,
  assignKycCasesHandler,
  recordKycAtDeskHandler,
  requestKycFromDeskHandler,
  setPublisherBandHandler,
  publicPublisherHandler,
} from './publishers.controller';
import {
  registerPublisherProfileHandler,
  getMyPublisherProfileHandler,
  getMyOnboardingQrHandler,
  cancelMyOnboardingHandler,
  cancelOnboardingHandler,
  completeOnboardingHandler,
  updateMyPublisherProfileHandler,
  getMyKycHandler,
  submitMyKycHandler,
  completeMyOnboardingHandler,
  getMyOnboardingQrStatusHandler,
  decideMyOnboardingScanHandler,
  initiateMyDigioKycHandler,
  getMyDigioKycStatusHandler,
  getMyAccessLogHandler,
} from './onboarding/publisher-onboarding.controller';
import { initiateDigioKycHandler, getDigioKycStatusHandler } from './kyc/digio.controller';
import { getMyAvailabilityHandler, getMyDashboardHandler, getMyListingsHandler } from './dashboard.controller';
import { listPublisherActivityHandler, publisherBookHandler, publisherSummaryHandler, recordPublisherActivityHandler } from './book/publisher-book.controller';
import { csvUploadMiddleware } from '../uploads';
import {
  commitImportHandler,
  getImportHandler,
  importPublishersHandler,
  importReportHandler,
  listImportsHandler,
  revokeImportHandler,
} from './import/publisher-import.controller';

export const publisherRouter = Router();
/* 26 Sep 2026: a publisher's public card — the website's storefront header
   (`/spaces?publisherId=`). No token; `{ id, name, avatarUrl, verified,
   liveListings }` only; rate-limited by IP. Above the router-wide authenticate. */
publisherRouter.get('/:publisherId/public', authenticateOptional, publicReadLimiter, asyncHandler(publicPublisherHandler));
publisherRouter.use(authenticate);

/* The agent's own book, on the list contract (DR 06). A literal path, ahead of /:publisherId. */
publisherRouter.get('/book', asyncHandler(publisherBookHandler));

// ── Publisher self-service (PUBLISHER role, user app) ──
// These literal paths must stay ahead of the /:publisherId routes below.
publisherRouter.post('/register', requireRole('PUBLISHER'), asyncHandler(registerPublisherProfileHandler));
publisherRouter.get('/me', requireRole('PUBLISHER'), asyncHandler(getMyPublisherProfileHandler));
/* DR 01's publisher home: the occupancy gauge and the map of their spots, computed for now. */
publisherRouter.get('/me/dashboard', requireRole('PUBLISHER'), asyncHandler(getMyDashboardHandler));
/* The publisher's own inventory. `/:publisherId/listings` below is the
   onboarding agent's read of the same spots and refuses the owner. */
publisherRouter.get('/me/listings', requireRole('PUBLISHER'), asyncHandler(getMyListingsHandler));
/* BD-1 (DR 12): the availability grid — the spots as rows, bookings, holds and blocks over a window. */
publisherRouter.get('/me/availability', requireRole('PUBLISHER'), asyncHandler(getMyAvailabilityHandler));
publisherRouter.get('/me/qr', requireRole('PUBLISHER'), asyncHandler(getMyOnboardingQrHandler));
publisherRouter.get('/me/qr/status', requireRole('PUBLISHER'), asyncHandler(getMyOnboardingQrStatusHandler));
publisherRouter.post('/me/qr/scans/:scanId/approve', requireRole('PUBLISHER'), asyncHandler(decideMyOnboardingScanHandler));
publisherRouter.post('/me/qr/scans/:scanId/decline', requireRole('PUBLISHER'), asyncHandler(decideMyOnboardingScanHandler));
publisherRouter.post('/me/cancel-onboarding', requireRole('PUBLISHER'), asyncHandler(cancelMyOnboardingHandler));
// DR 08 self-service: the publisher's own profile, documents and completion.
publisherRouter.patch('/me', requireRole('PUBLISHER'), asyncHandler(updateMyPublisherProfileHandler));
publisherRouter.get('/me/kyc', requireRole('PUBLISHER'), asyncHandler(getMyKycHandler));
publisherRouter.post('/me/kyc', requireRole('PUBLISHER'), asyncHandler(submitMyKycHandler));
publisherRouter.post('/me/complete-onboarding', requireRole('PUBLISHER'), asyncHandler(completeMyOnboardingHandler));
// U7: KYC by Digio, the publisher's own choice. U9: who has had access.
publisherRouter.post('/me/kyc/digio/initiate', requireRole('PUBLISHER'), asyncHandler(initiateMyDigioKycHandler));
publisherRouter.get('/me/kyc/digio/status', requireRole('PUBLISHER'), asyncHandler(getMyDigioKycStatusHandler));
publisherRouter.get('/me/access-log', requireRole('PUBLISHER'), asyncHandler(getMyAccessLogHandler));

// D7: the ADMIN KYC queue — literal paths, so they stay ahead of /:publisherId.
publisherRouter.get('/kyc-queue', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(kycQueueHandler));
// Lot D (Q119): bulk assignment — a literal path, ahead of /kyc-queue/:publisherId.
publisherRouter.post('/kyc-queue/assign', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(assignKycCasesHandler));
publisherRouter.get('/kyc-queue/:publisherId', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(kycCaseHandler));
// Lot N: the desk's two new paths — the KYC requested from the desk, or recorded at it on the publisher's behalf.
publisherRouter.put('/kyc-queue/:publisherId', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(recordKycAtDeskHandler));
// N3-B: the one click is the catalogue's KYC edit tier beside ADMIN (a role config granted `kyc.edit` may
// send it; the super admin and an admin with no role config pass under the launch rule).
publisherRouter.post('/kyc-queue/:publisherId/request', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(requestKycFromDeskHandler));
publisherRouter.post('/kyc-queue/:publisherId/digio/restart', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(restartDigioKycHandler));
// Lot D (Q42/Q119): the per-document desk — one tile, the re-upload ask, who is working it.
publisherRouter.patch('/kyc-queue/:publisherId/documents/:field', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(reviewKycDocumentHandler));
publisherRouter.post('/kyc-queue/:publisherId/request-reupload', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(requestKycReuploadHandler));
publisherRouter.patch('/kyc-queue/:publisherId/assign', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(assignKycCaseHandler));
// Lot G (Q127/142): the reviewer hands the case to Compliance.
publisherRouter.post('/kyc-queue/:publisherId/escalate', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(escalateKycCaseHandler));

// Lot D (Q43/Q86): the legacy book, imported — literal paths, ahead of /:publisherId.
// The CSV multer runs first and steps aside for a JSON body.
publisherRouter.post('/import', requireRole('ADMIN'), requirePermission('supply.import'), csvUploadMiddleware, asyncHandler(importPublishersHandler));
publisherRouter.get('/imports', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(listImportsHandler));
publisherRouter.get('/imports/:id', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(getImportHandler));
publisherRouter.post('/imports/:id/commit', requireRole('ADMIN'), requirePermission('supply.import'), asyncHandler(commitImportHandler));
publisherRouter.post('/imports/:id/revoke', requireRole('ADMIN'), requirePermission('supply.import'), asyncHandler(revokeImportHandler));
publisherRouter.get('/imports/:id/report.csv', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(importReportHandler));

// ── Agent / admin publisher management ──
publisherRouter.get('/', asyncHandler(getPublishersHandler));
// Q29: ADX opens publisher accounts from the desk as well as agents opening
// them at the door. The two paths differ only in attribution — see the handler.
publisherRouter.post('/', requireRole('AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'), asyncHandler(createPublisherHandler));
publisherRouter.get('/:publisherId', asyncHandler(getPublisherHandler));
// P-B: the detail card — the row, the money, the spots and the feed — the mirror of /advertisers/:id/summary.
publisherRouter.get('/:publisherId/summary', requireRole('ADMIN'), requirePermission('supply.view'), asyncHandler(publisherSummaryHandler));
// R-B: the action log — the mirror of /advertisers/:id/activity; the account's own agent (no live grant) or ADMIN, decided in the service.
publisherRouter.get('/:publisherId/activity', asyncHandler(listPublisherActivityHandler));
publisherRouter.post('/:publisherId/activity', asyncHandler(recordPublisherActivityHandler));
// QR-13: the desk edits a publisher the way the ladder fills one; the agent path is unchanged.
publisherRouter.patch('/:publisherId', requireRole('AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'), asyncHandler(updatePublisherHandler));
// AG-5: the importance band — the withdrawal ladder's and the agent grade's axis — set by the desk alone.
publisherRouter.patch('/:publisherId/band', requireRole('ADMIN'), requirePermission('supply.edit'), asyncHandler(setPublisherBandHandler));
publisherRouter.post('/:publisherId/kyc', requireRole('AGENT_PUBLISHER'), asyncHandler(submitKycHandler));
publisherRouter.post('/:publisherId/kyc/review', requireRole('ADMIN'), requirePermission('kyc.approve'), asyncHandler(reviewKycHandler));
publisherRouter.post('/:publisherId/kyc/digio/initiate', requireRole('AGENT_PUBLISHER'), asyncHandler(initiateDigioKycHandler));
publisherRouter.get('/:publisherId/kyc/digio/status', asyncHandler(getDigioKycStatusHandler));
publisherRouter.get('/:publisherId/onboarding-status', asyncHandler(getOnboardingStatusHandler));
publisherRouter.post('/:publisherId/cancel-onboarding', requireRole('AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'), asyncHandler(cancelOnboardingHandler));
publisherRouter.post('/:publisherId/complete-onboarding', requireRole('AGENT_PUBLISHER', 'ADMIN'), requirePermission('supply.edit'), asyncHandler(completeOnboardingHandler));
publisherRouter.get('/:publisherId/listings', asyncHandler(getPublisherListingsHandler));
