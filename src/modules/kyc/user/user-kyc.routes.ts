import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole } from '../../../shared/auth';
import {
  attestPresenceHandler,
  createUserKycHandler,
  getMyUserKycHandler,
  submitLivenessOnBehalfHandler,
  getUserKycByIdHandler,
  getAllUserKycsHandler,
  reviewUserKycHandler,
  submitLivenessHandler,
  deleteUserKycHandler,
  deleteUserKycByIdHandler,
} from './user-kyc.controller';

export const userKycRouter = Router();
userKycRouter.use(authenticate);

// The /me paths must stay ahead of /:id.
userKycRouter.post('/', asyncHandler(createUserKycHandler));
userKycRouter.get('/me', asyncHandler(getMyUserKycHandler));
// Lot D (Q131): the liveness video, named by the private file the phone uploaded.
userKycRouter.post('/me', asyncHandler(submitLivenessHandler));
userKycRouter.delete('/me', asyncHandler(deleteUserKycHandler));

userKycRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllUserKycsHandler));
userKycRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getUserKycByIdHandler));
userKycRouter.patch('/:id/review', requireRole('ADMIN'), asyncHandler(reviewUserKycHandler));
// Lot N: presence at the desk — an admin attests it, or records the video the desk captured. By the person's user id.
userKycRouter.post('/:userId/attest', requireRole('ADMIN'), asyncHandler(attestPresenceHandler));
userKycRouter.post('/:userId', requireRole('ADMIN'), asyncHandler(submitLivenessOnBehalfHandler));
userKycRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteUserKycByIdHandler));
