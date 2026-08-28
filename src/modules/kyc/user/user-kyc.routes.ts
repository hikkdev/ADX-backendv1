import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole } from '../../../shared/auth';
import {
  createUserKycHandler,
  getMyUserKycHandler,
  getUserKycByIdHandler,
  getAllUserKycsHandler,
  reviewUserKycHandler,
  deleteUserKycHandler,
  deleteUserKycByIdHandler,
} from './user-kyc.controller';

export const userKycRouter = Router();
userKycRouter.use(authenticate);

// The /me paths must stay ahead of /:id.
userKycRouter.post('/', asyncHandler(createUserKycHandler));
userKycRouter.get('/me', asyncHandler(getMyUserKycHandler));
userKycRouter.delete('/me', asyncHandler(deleteUserKycHandler));

userKycRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllUserKycsHandler));
userKycRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getUserKycByIdHandler));
userKycRouter.patch('/:id/review', requireRole('ADMIN'), asyncHandler(reviewUserKycHandler));
userKycRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteUserKycByIdHandler));
