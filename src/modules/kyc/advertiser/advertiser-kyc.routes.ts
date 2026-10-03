import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../../shared/auth';
import {
  createAdvertiserKycHandler,
  getMyAdvertiserKycHandler,
  getAllAdvertiserKycsHandler,
  getAdvertiserKycByIdHandler,
  updateAdvertiserKycHandler,
  updateAdvertiserKycByIdHandler,
  initiateMyAdvertiserDigioHandler,
  myAdvertiserDigioStatusHandler,
  restartAdvertiserDigioHandler,
  reviewAdvertiserKycHandler,
  deleteAdvertiserKycHandler,
  reviewAdvertiserDocumentHandler,
  requestAdvertiserReuploadHandler,
  requestAdvertiserKycHandler,
  assignAdvertiserCaseHandler,
  escalateAdvertiserCaseHandler,
} from './advertiser-kyc.controller';

export const advertiserKycRouter = Router();
advertiserKycRouter.use(authenticate);

// Self-service (advertiser's own KYC). The /me paths must stay ahead of /:id.
advertiserKycRouter.post('/', asyncHandler(createAdvertiserKycHandler));
advertiserKycRouter.get('/me', asyncHandler(getMyAdvertiserKycHandler));
advertiserKycRouter.put('/me', asyncHandler(updateAdvertiserKycHandler));

// U7, demand side: Digio from the advertiser's own phone. Literal paths, ahead of /:id.
advertiserKycRouter.post('/me/digio/initiate', asyncHandler(initiateMyAdvertiserDigioHandler));
advertiserKycRouter.get('/me/digio/status', asyncHandler(myAdvertiserDigioStatusHandler));

// Admin review
advertiserKycRouter.get('/', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(getAllAdvertiserKycsHandler));
advertiserKycRouter.get('/:id', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(getAdvertiserKycByIdHandler));
advertiserKycRouter.put('/:id', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(updateAdvertiserKycByIdHandler));
advertiserKycRouter.patch('/:id/review', requireRole('ADMIN'), requirePermission('kyc.approve'), asyncHandler(reviewAdvertiserKycHandler));
// Lot D (Q42/Q119): the per-document desk — one tile, the re-upload ask, who is working it.
advertiserKycRouter.patch('/:id/documents/:field', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(reviewAdvertiserDocumentHandler));
advertiserKycRouter.post('/:id/request-reupload', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(requestAdvertiserReuploadHandler));
advertiserKycRouter.patch('/:id/assign', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(assignAdvertiserCaseHandler));
// Lot G (Q127/142): the reviewer hands the case to Compliance.
advertiserKycRouter.post('/:id/escalate', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(escalateAdvertiserCaseHandler));
advertiserKycRouter.post('/:id/digio/restart', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(restartAdvertiserDigioHandler));
// Lot N: the desk asks for the KYC — by the row id, the profile id or the advertiser's user id.
// N3-B: the one click is the catalogue's KYC edit tier — a role config granted `kyc.edit` may send it;
// the super admin and an admin with no role config pass under the launch rule.
advertiserKycRouter.post('/:id/request', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(requestAdvertiserKycHandler));
advertiserKycRouter.delete('/:id', requireRole('ADMIN'), requirePermission('kyc.delete'), asyncHandler(deleteAdvertiserKycHandler));
