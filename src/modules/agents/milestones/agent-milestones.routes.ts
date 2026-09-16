import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole } from '../../../shared/auth';
import {
  claimMilestoneHandler,
  createMilestoneTemplateHandler,
  getMilestoneTemplateHandler,
  getMilestonesHandler,
  listMilestoneTemplatesHandler,
  patchMilestoneTemplateHandler,
} from './agent-milestones.controller';

export const milestoneRouter = Router();
milestoneRouter.use(authenticate);

/* The agent's own board. `/templates` is declared before `/:milestoneId` so
 * it is never read as an id. */
milestoneRouter.get('/', asyncHandler(getMilestonesHandler));
milestoneRouter.get('/templates', requireRole('ADMIN'), asyncHandler(listMilestoneTemplatesHandler));
milestoneRouter.post('/templates', requireRole('ADMIN'), asyncHandler(createMilestoneTemplateHandler));
milestoneRouter.get('/templates/:templateId', requireRole('ADMIN'), asyncHandler(getMilestoneTemplateHandler));
milestoneRouter.patch('/templates/:templateId', requireRole('ADMIN'), asyncHandler(patchMilestoneTemplateHandler));
milestoneRouter.post('/:milestoneId/claim', asyncHandler(claimMilestoneHandler));
