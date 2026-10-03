import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  createTemplateHandler,
  listTemplatesHandler,
  getTemplateHandler,
  updateTemplateHandler,
  createPlanHandler,
  listPlansHandler,
  getPlanHandler,
  updatePlanHandler,
  replacePlanItemsHandler,
  getOrderMilestonesHandler,
  addMilestoneToOrderHandler,
  updateOrderMilestoneHandler,
  removeOrderMilestoneHandler,
  getAgentMilestonesHandler,
  getMilestoneDetailHandler,
  startMilestoneHandler,
  completeMilestoneHandler,
  acceptMilestoneHandler,
  rejectMilestoneHandler,
  milestoneSlotCandidatesHandler,
  milestoneLocationHandler,
  scheduleMilestoneHandler,
} from './order-milestones.controller';

export const milestoneTemplateRouter = Router();
milestoneTemplateRouter.use(authenticate);

milestoneTemplateRouter.post('/', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(createTemplateHandler));
milestoneTemplateRouter.get('/', requirePermission('content.view'), asyncHandler(listTemplatesHandler));
milestoneTemplateRouter.get('/:id', requirePermission('content.view'), asyncHandler(getTemplateHandler));
milestoneTemplateRouter.patch('/:id', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(updateTemplateHandler));

export const milestonePlanRouter = Router();
milestonePlanRouter.use(authenticate);

milestonePlanRouter.post('/', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(createPlanHandler));
milestonePlanRouter.get('/', asyncHandler(listPlansHandler));
milestonePlanRouter.get('/:id', asyncHandler(getPlanHandler));
milestonePlanRouter.patch('/:id', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(updatePlanHandler));
milestonePlanRouter.put('/:id/items', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(replacePlanItemsHandler));

// mergeParams so :orderId from the mount path reaches these handlers.
export const orderMilestoneRouter = Router({ mergeParams: true });
orderMilestoneRouter.use(authenticate);

orderMilestoneRouter.get('/', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(getOrderMilestonesHandler));
orderMilestoneRouter.post('/', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(addMilestoneToOrderHandler));
orderMilestoneRouter.patch('/:milestoneId', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(updateOrderMilestoneHandler));
orderMilestoneRouter.delete('/:milestoneId', requireRole('ADMIN'), requirePermission('marketplace.delete'), asyncHandler(removeOrderMilestoneHandler));

export const agentMilestoneRouter = Router();
agentMilestoneRouter.use(authenticate);
agentMilestoneRouter.use(requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'));

agentMilestoneRouter.get('/', requirePermission('agents.view'), asyncHandler(getAgentMilestonesHandler));
agentMilestoneRouter.get('/:milestoneId', asyncHandler(getMilestoneDetailHandler));
// A12: the offer's answers, then the slot — DR 01's three sheets.
agentMilestoneRouter.post('/:milestoneId/accept', asyncHandler(acceptMilestoneHandler));
agentMilestoneRouter.post('/:milestoneId/reject', asyncHandler(rejectMilestoneHandler));
agentMilestoneRouter.get('/:milestoneId/slot-candidates', asyncHandler(milestoneSlotCandidatesHandler));
agentMilestoneRouter.post('/:milestoneId/schedule', asyncHandler(scheduleMilestoneHandler));
agentMilestoneRouter.post('/:milestoneId/start', asyncHandler(startMilestoneHandler));
agentMilestoneRouter.post('/:milestoneId/complete', asyncHandler(completeMilestoneHandler));
// G12-B: the live-position ping on the way to the visit — the order lane's
// body, written onto the milestone's order.
agentMilestoneRouter.post('/:milestoneId/update-location', asyncHandler(milestoneLocationHandler));
