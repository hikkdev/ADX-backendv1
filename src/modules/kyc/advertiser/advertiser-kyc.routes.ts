import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole } from '../../../shared/auth';
import {
  createAdvertiserKycHandler,
  getMyAdvertiserKycHandler,
  getAllAdvertiserKycsHandler,
  getAdvertiserKycByIdHandler,
  updateAdvertiserKycHandler,
  updateAdvertiserKycByIdHandler,
  reviewAdvertiserKycHandler,
  deleteAdvertiserKycHandler,
} from './advertiser-kyc.controller';

export const advertiserKycRouter = Router();
advertiserKycRouter.use(authenticate);

// Self-service (advertiser's own KYC). The /me paths must stay ahead of /:id.
advertiserKycRouter.post('/', asyncHandler(createAdvertiserKycHandler));
advertiserKycRouter.get('/me', asyncHandler(getMyAdvertiserKycHandler));
advertiserKycRouter.put('/me', asyncHandler(updateAdvertiserKycHandler));

// Admin review
advertiserKycRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllAdvertiserKycsHandler));
advertiserKycRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getAdvertiserKycByIdHandler));
advertiserKycRouter.put('/:id', requireRole('ADMIN'), asyncHandler(updateAdvertiserKycByIdHandler));
advertiserKycRouter.patch('/:id/review', requireRole('ADMIN'), asyncHandler(reviewAdvertiserKycHandler));
advertiserKycRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteAdvertiserKycHandler));
