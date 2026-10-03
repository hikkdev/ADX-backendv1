import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../../shared/auth';
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
milestoneRouter.get('/templates', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(listMilestoneTemplatesHandler));
milestoneRouter.post('/templates', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(createMilestoneTemplateHandler));
milestoneRouter.get('/templates/:templateId', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(getMilestoneTemplateHandler));
milestoneRouter.patch('/templates/:templateId', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(patchMilestoneTemplateHandler));
milestoneRouter.post('/:milestoneId/claim', asyncHandler(claimMilestoneHandler));
