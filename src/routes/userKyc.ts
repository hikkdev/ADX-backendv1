import { Router } from 'express';
import {
  createUserKycHandler,
  getMyUserKycHandler,
  getUserKycByIdHandler,
  getAllUserKycsHandler,
  reviewUserKycHandler,
  deleteUserKycHandler,
  deleteUserKycByIdHandler,
} from '../controllers/userKyc';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const userKycRouter = Router();
userKycRouter.use(authenticate);

userKycRouter.post('/', asyncHandler(createUserKycHandler));
userKycRouter.get('/me', asyncHandler(getMyUserKycHandler));
userKycRouter.delete('/me', asyncHandler(deleteUserKycHandler));

userKycRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllUserKycsHandler));
userKycRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getUserKycByIdHandler));
userKycRouter.patch('/:id/review', requireRole('ADMIN'), asyncHandler(reviewUserKycHandler));
userKycRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteUserKycByIdHandler));
