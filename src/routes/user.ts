import { Router } from 'express';
import {
  getMe,
  updateMe,
  assignRole,
  bootstrapAdmin,
  createUser,
  getAllUsers,
  deleteUser,
  updateUserByAdmin,
  listMySessions,
  revokeMySession,
  listMyActivity,
} from '../controllers/user';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const userRouter = Router();

// Bootstrap: no auth required — only works when zero admins exist
userRouter.post('/bootstrap-admin', asyncHandler(bootstrapAdmin));

userRouter.use(authenticate);

userRouter.get('/me', asyncHandler(getMe));
userRouter.patch('/me', asyncHandler(updateMe));
userRouter.get('/me/sessions', asyncHandler(listMySessions));
userRouter.delete('/me/sessions/:id', asyncHandler(revokeMySession));
userRouter.get('/me/activity', asyncHandler(listMyActivity));

// Admin only
userRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllUsers));
userRouter.post('/', requireRole('ADMIN'), asyncHandler(createUser));
userRouter.post('/roles', requireRole('ADMIN'), asyncHandler(assignRole));
userRouter.patch('/:id', requireRole('ADMIN'), asyncHandler(updateUserByAdmin));
userRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteUser));
