import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole } from '../../../shared/auth';
import {
  getMilestonesHandler, createMilestoneTemplateHandler,
  getTrainingHandler, createTrainingHandler,
} from './agent-milestones.controller';

export const milestoneRouter = Router();
milestoneRouter.use(authenticate);

milestoneRouter.get('/', asyncHandler(getMilestonesHandler));
milestoneRouter.post('/templates', requireRole('ADMIN'), asyncHandler(createMilestoneTemplateHandler));

export const trainingRouter = Router();
trainingRouter.use(authenticate);

trainingRouter.get('/', asyncHandler(getTrainingHandler));
trainingRouter.post('/', requireRole('ADMIN'), asyncHandler(createTrainingHandler));
