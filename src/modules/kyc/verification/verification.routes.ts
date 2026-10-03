import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../../shared/auth';
import { handleUploadMiddleware } from '../../uploads';
import {
  getSessionHandler,
  listMySessionsHandler,
  listAttemptsHandler,
  refreshDigilockerHandler,
  resendOnBackupHandler,
  secureIdWebhookHandler,
  startDigilockerHandler,
  submitBankHandler,
  submitBusinessHandler,
  submitDrivingLicenceHandler,
  submitSelfieHandler,
  submitVehicleHandler,
  verificationHealthHandler,
} from './verification.controller';

/**
 * Cashfree Phase 1 — `/verification`.
 *
 * The session routes are the person's own: any signed-in account may call
 * them, and the service answers 404 for a session that is not the caller's.
 * The three desk routes sit behind ADMIN and the KYC desk's own permissions
 * — the ones the KYC queues use: `kyc.view` to read, `kyc.edit` to send a
 * case to the backup.
 */
export const verificationRouter = Router();
verificationRouter.use(authenticate);

// The desk. Literal paths, ahead of anything with a parameter.
verificationRouter.get('/attempts', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(listAttemptsHandler));
verificationRouter.get('/health', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(verificationHealthHandler));
verificationRouter.post('/cases/:caseType/:caseId/resend-on-backup', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(resendOnBackupHandler));

// The person's own session.
verificationRouter.get('/sessions/mine', asyncHandler(listMySessionsHandler));
verificationRouter.get('/sessions/:id', asyncHandler(getSessionHandler));
verificationRouter.post('/sessions/:id/digilocker', asyncHandler(startDigilockerHandler));
verificationRouter.post('/sessions/:id/digilocker/refresh', asyncHandler(refreshDigilockerHandler));
// The selfie rides the upload intake's multipart door (field `file`); the handler keeps nothing.
verificationRouter.post('/sessions/:id/selfie', handleUploadMiddleware, asyncHandler(submitSelfieHandler));
verificationRouter.post('/sessions/:id/bank', asyncHandler(submitBankHandler));
verificationRouter.post('/sessions/:id/business', asyncHandler(submitBusinessHandler));
verificationRouter.post('/sessions/:id/driving-licence', asyncHandler(submitDrivingLicenceHandler));
verificationRouter.post('/sessions/:id/vehicle', asyncHandler(submitVehicleHandler));

/** Cashfree Secure ID's callback — signed by Cashfree, so it carries no session of ours. Mounted at `/webhooks/cashfree/verification`. */
export const secureIdWebhookRouter = Router();
secureIdWebhookRouter.post('/', asyncHandler(secureIdWebhookHandler));
