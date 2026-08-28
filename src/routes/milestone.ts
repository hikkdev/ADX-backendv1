import { Router } from 'express';
import {
  getMilestonesHandler, createMilestoneTemplateHandler,
  getTrainingHandler, createTrainingHandler,
} from '../controllers/milestone';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const milestoneRouter = Router();
milestoneRouter.use(authenticate);

milestoneRouter.get('/', asyncHandler(getMilestonesHandler));
milestoneRouter.post('/templates', requireRole('ADMIN'), asyncHandler(createMilestoneTemplateHandler));

export const trainingRouter = Router();
trainingRouter.use(authenticate);

trainingRouter.get('/', asyncHandler(getTrainingHandler));
trainingRouter.post('/', requireRole('ADMIN'), asyncHandler(createTrainingHandler));
