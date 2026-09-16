import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  placeOrderHandler, getAllOrdersHandler, bookingCalendarHandler, getMyOrdersHandler, getOrderByIdHandler,
  publisherAcceptHandler, publisherRejectHandler, chooseFulfilmentHandler,
  printReadyHandler, adminAssignAgentHandler,
  agentAcceptHandler, agentRejectHandler, proposeSlotHandler, slotCandidatesHandler, pickupCodeHandler,
  confirmSlotHandler, counterSlotHandler,
  collectPrintsHandler, captureConditionHandler, rejectConditionHandler,
  captureInstallationHandler, submitInstallationHandler, evidenceHandler, jobLadderHandler,
  requestOtpHandler, verifyOtpHandler,
  approveOrderHandler, cancelOrderHandler, endCampaignHandler,
  selfInstallCollectPrintsHandler, selfInstallCaptureConditionHandler,
  selfInstallCheckInHandler, selfInstallCaptureInstallationHandler,
  agentOffersHandler,
  reassignAgentHandler, opsAcceptPublisherHandler, opsConfirmSlotHandler, opsCollectPrintsHandler,
} from './orders.controller';
import {
  agentCheckInHandler, updateLocationHandler, agentLocationHandler,
} from './tracking/tracking.controller';

export const orderRouter = Router();
orderRouter.use(authenticate);

// `/my` must stay ahead of `/:id`, or it would be read as an order id.
// Ops: every offer an agent has had, with the five coded reasons counted. Literal path, ahead of /:id.
orderRouter.get('/agents/:agentId/offers', requireRole('ADMIN'), asyncHandler(agentOffersHandler));
orderRouter.get('/my', asyncHandler(getMyOrdersHandler));
// Lot G (Q114): the booking calendar — a listings-first read. Literal path, ahead of /:id.
orderRouter.get('/calendar', requireRole('ADMIN'), asyncHandler(bookingCalendarHandler));
/* Lot G (Q126/Q141): the A1–A8 checklist as data — `flows.agent-job`, or the
   code ladder. Literal path, ahead of /:id; any session, as the app reads it
   before a job is opened. */
orderRouter.get('/job-ladder', asyncHandler(jobLadderHandler));
orderRouter.get('/:id', asyncHandler(getOrderByIdHandler));

orderRouter.post('/', requireRole('ADVERTISER'), asyncHandler(placeOrderHandler));

orderRouter.post('/:id/accept-publisher', requireRole('PUBLISHER'), asyncHandler(publisherAcceptHandler));
orderRouter.post('/:id/reject-publisher', requireRole('PUBLISHER'), asyncHandler(publisherRejectHandler));
/* P2. Only meaningful between accepting and the prints being ready, which the
   service enforces — the route is open to the publisher for the whole life of
   the order so a late attempt gets an explanation rather than a 403. */
orderRouter.post('/:id/choose-fulfilment', requireRole('PUBLISHER'), asyncHandler(chooseFulfilmentHandler));
orderRouter.post('/:id/confirm-slot',     requireRole('PUBLISHER'), asyncHandler(confirmSlotHandler));
orderRouter.post('/:id/counter-slot',     requireRole('PUBLISHER'), asyncHandler(counterSlotHandler));
orderRouter.post('/:id/self-install/collect-prints',       requireRole('PUBLISHER'), asyncHandler(selfInstallCollectPrintsHandler));
orderRouter.post('/:id/self-install/capture-condition',    requireRole('PUBLISHER'), asyncHandler(selfInstallCaptureConditionHandler));
orderRouter.post('/:id/self-install/checkin',              requireRole('PUBLISHER'), asyncHandler(selfInstallCheckInHandler));
orderRouter.post('/:id/self-install/capture-installation', requireRole('PUBLISHER'), asyncHandler(selfInstallCaptureInstallationHandler));

orderRouter.post('/:id/accept-agent',         requireRole('AGENT_PUBLISHER'), asyncHandler(agentAcceptHandler));
orderRouter.post('/:id/reject-agent',         requireRole('AGENT_PUBLISHER'), asyncHandler(agentRejectHandler));
orderRouter.post('/:id/propose-slot',         requireRole('AGENT_PUBLISHER'), asyncHandler(proposeSlotHandler));
orderRouter.get('/:id/slot-candidates',       requireRole('AGENT_PUBLISHER'), asyncHandler(slotCandidatesHandler));
orderRouter.post('/:id/collect-prints',       requireRole('AGENT_PUBLISHER'), asyncHandler(collectPrintsHandler));
orderRouter.get('/:id/pickup-code',           requireRole('ADMIN', 'AGENT_PUBLISHER'), asyncHandler(pickupCodeHandler));
orderRouter.post('/:id/checkin',              requireRole('AGENT_PUBLISHER'), asyncHandler(agentCheckInHandler));
orderRouter.post('/:id/capture-condition',    requireRole('AGENT_PUBLISHER'), asyncHandler(captureConditionHandler));
orderRouter.post('/:id/reject-condition',     requireRole('AGENT_PUBLISHER'), asyncHandler(rejectConditionHandler));
orderRouter.post('/:id/capture-installation', requireRole('AGENT_PUBLISHER'), asyncHandler(captureInstallationHandler));
/* The step that was missing: IN_PROGRESS had four actions and no way out of it. */
orderRouter.post('/:id/submit-installation',  requireRole('AGENT_PUBLISHER'), asyncHandler(submitInstallationHandler));
orderRouter.post('/:id/request-otp',          requireRole('AGENT_PUBLISHER'), asyncHandler(requestOtpHandler));
orderRouter.post('/:id/verify-otp',           requireRole('AGENT_PUBLISHER'), asyncHandler(verifyOtpHandler));
orderRouter.post('/:id/update-location',      requireRole('AGENT_PUBLISHER'), asyncHandler(updateLocationHandler));
/* Lot D (Q90): the console's live map reads the same ping the publisher does. */
orderRouter.get('/:id/agent-location',        requireRole('PUBLISHER', 'ADMIN'), asyncHandler(agentLocationHandler));
/* Readable by anyone who may read the order: the agent needs it to know what is
   left, and the publisher needs it to see what was filed. */
orderRouter.get('/:id/evidence', asyncHandler(evidenceHandler));

orderRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllOrdersHandler));
orderRouter.post('/:id/print-ready',   requireRole('ADMIN'), asyncHandler(printReadyHandler));
orderRouter.post('/:id/assign-agent',  requireRole('ADMIN'), asyncHandler(adminAssignAgentHandler));
orderRouter.post('/:id/approve',       requireRole('ADMIN'), asyncHandler(approveOrderHandler));
orderRouter.post('/:id/cancel',        requireRole('ADMIN'), asyncHandler(cancelOrderHandler));
orderRouter.post('/:id/end-campaign',  requireRole('ADMIN'), asyncHandler(endCampaignHandler));
/*
 * Lot D (Q51/Q90): the four ops moves, each with a mandatory reason and an
 * ORDER_OPS_OVERRIDE / ORDER_AGENT_REASSIGNED audit row. There is deliberately
 * no ops path for check-in, the photographs or the OTP: those are the proof a
 * person was at the site, and ADX cannot give it for them.
 */
orderRouter.post('/:id/reassign-agent',        requireRole('ADMIN'), asyncHandler(reassignAgentHandler));
orderRouter.post('/:id/ops/accept-publisher',  requireRole('ADMIN'), asyncHandler(opsAcceptPublisherHandler));
orderRouter.post('/:id/ops/confirm-slot',      requireRole('ADMIN'), asyncHandler(opsConfirmSlotHandler));
orderRouter.post('/:id/ops/collect-prints',    requireRole('ADMIN'), asyncHandler(opsCollectPrintsHandler));
