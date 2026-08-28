import { Router } from 'express';
import {
  createAdvertiserKycHandler,
  getMyAdvertiserKycHandler,
  getAllAdvertiserKycsHandler,
  getAdvertiserKycByIdHandler,
  updateAdvertiserKycHandler,
  updateAdvertiserKycByIdHandler,
  reviewAdvertiserKycHandler,
  deleteAdvertiserKycHandler,
} from '../controllers/advertiserKyc';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const advertiserKycRouter = Router();
advertiserKycRouter.use(authenticate);

// Self-service (advertiser's own KYC)
advertiserKycRouter.post('/', asyncHandler(createAdvertiserKycHandler));
advertiserKycRouter.get('/me', asyncHandler(getMyAdvertiserKycHandler));
advertiserKycRouter.put('/me', asyncHandler(updateAdvertiserKycHandler));

// Admin review
advertiserKycRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllAdvertiserKycsHandler));
advertiserKycRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getAdvertiserKycByIdHandler));
advertiserKycRouter.put('/:id', requireRole('ADMIN'), asyncHandler(updateAdvertiserKycByIdHandler));
advertiserKycRouter.patch('/:id/review', requireRole('ADMIN'), asyncHandler(reviewAdvertiserKycHandler));
advertiserKycRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteAdvertiserKycHandler));
