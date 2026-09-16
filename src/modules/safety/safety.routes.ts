import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { mineHandler, queueHandler, raiseHandler, updateHandler } from './safety.controller';

export const safetyRouter = Router();
safetyRouter.use(authenticate);

/* `/mine` above the queue so it is never read as a filter, and the queue is
 * ADMIN because a safety report names where somebody is standing. */
safetyRouter.get('/alerts/mine', asyncHandler(mineHandler));
safetyRouter.post('/alerts', asyncHandler(raiseHandler));
safetyRouter.get('/alerts', requireRole('ADMIN'), asyncHandler(queueHandler));
safetyRouter.patch('/alerts/:alertId', requireRole('ADMIN'), asyncHandler(updateHandler));
