import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  placeOrderHandler, getAllOrdersHandler, getMyOrdersHandler, getOrderByIdHandler,
  publisherAcceptHandler, publisherRejectHandler,
  printReadyHandler, adminAssignAgentHandler,
  agentAcceptHandler, agentRejectHandler, proposeSlotHandler,
  confirmSlotHandler, counterSlotHandler,
  collectPrintsHandler, captureConditionHandler, rejectConditionHandler,
  captureInstallationHandler, requestOtpHandler, verifyOtpHandler,
  approveOrderHandler, cancelOrderHandler, endCampaignHandler,
  selfInstallCollectPrintsHandler, selfInstallCaptureConditionHandler,
  selfInstallCheckInHandler, selfInstallCaptureInstallationHandler,
} from './orders.controller';
import {
  agentCheckInHandler, updateLocationHandler, agentLocationHandler,
} from './tracking/tracking.controller';

export const orderRouter = Router();
orderRouter.use(authenticate);

// `/my` must stay ahead of `/:id`, or it would be read as an order id.
orderRouter.get('/my', asyncHandler(getMyOrdersHandler));
orderRouter.get('/:id', asyncHandler(getOrderByIdHandler));

orderRouter.post('/', requireRole('ADVERTISER'), asyncHandler(placeOrderHandler));

orderRouter.post('/:id/accept-publisher', requireRole('PUBLISHER'), asyncHandler(publisherAcceptHandler));
orderRouter.post('/:id/reject-publisher', requireRole('PUBLISHER'), asyncHandler(publisherRejectHandler));
orderRouter.post('/:id/confirm-slot',     requireRole('PUBLISHER'), asyncHandler(confirmSlotHandler));
orderRouter.post('/:id/counter-slot',     requireRole('PUBLISHER'), asyncHandler(counterSlotHandler));
orderRouter.post('/:id/self-install/collect-prints',       requireRole('PUBLISHER'), asyncHandler(selfInstallCollectPrintsHandler));
orderRouter.post('/:id/self-install/capture-condition',    requireRole('PUBLISHER'), asyncHandler(selfInstallCaptureConditionHandler));
orderRouter.post('/:id/self-install/checkin',              requireRole('PUBLISHER'), asyncHandler(selfInstallCheckInHandler));
orderRouter.post('/:id/self-install/capture-installation', requireRole('PUBLISHER'), asyncHandler(selfInstallCaptureInstallationHandler));

orderRouter.post('/:id/accept-agent',         requireRole('AGENT_PUBLISHER'), asyncHandler(agentAcceptHandler));
orderRouter.post('/:id/reject-agent',         requireRole('AGENT_PUBLISHER'), asyncHandler(agentRejectHandler));
orderRouter.post('/:id/propose-slot',         requireRole('AGENT_PUBLISHER'), asyncHandler(proposeSlotHandler));
orderRouter.post('/:id/collect-prints',       requireRole('AGENT_PUBLISHER'), asyncHandler(collectPrintsHandler));
orderRouter.post('/:id/checkin',              requireRole('AGENT_PUBLISHER'), asyncHandler(agentCheckInHandler));
orderRouter.post('/:id/capture-condition',    requireRole('AGENT_PUBLISHER'), asyncHandler(captureConditionHandler));
orderRouter.post('/:id/reject-condition',     requireRole('AGENT_PUBLISHER'), asyncHandler(rejectConditionHandler));
orderRouter.post('/:id/capture-installation', requireRole('AGENT_PUBLISHER'), asyncHandler(captureInstallationHandler));
orderRouter.post('/:id/request-otp',          requireRole('AGENT_PUBLISHER'), asyncHandler(requestOtpHandler));
orderRouter.post('/:id/verify-otp',           requireRole('AGENT_PUBLISHER'), asyncHandler(verifyOtpHandler));
orderRouter.post('/:id/update-location',      requireRole('AGENT_PUBLISHER'), asyncHandler(updateLocationHandler));
orderRouter.get('/:id/agent-location',        requireRole('PUBLISHER'), asyncHandler(agentLocationHandler));

orderRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllOrdersHandler));
orderRouter.post('/:id/print-ready',   requireRole('ADMIN'), asyncHandler(printReadyHandler));
orderRouter.post('/:id/assign-agent',  requireRole('ADMIN'), asyncHandler(adminAssignAgentHandler));
orderRouter.post('/:id/approve',       requireRole('ADMIN'), asyncHandler(approveOrderHandler));
orderRouter.post('/:id/cancel',        requireRole('ADMIN'), asyncHandler(cancelOrderHandler));
orderRouter.post('/:id/end-campaign',  requireRole('ADMIN'), asyncHandler(endCampaignHandler));
