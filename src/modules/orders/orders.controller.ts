import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { requireAgentProfile } from '../agents';
import { orderError } from './orders.errors';
import {
  agentIdSchema,
  completionOtpSchema,
  counterNoteSchema,
  listOrdersQuerySchema,
  meetingPlaceSchema,
  photoUrlSchema,
  photoUrlsSchema,
  placeOrderSchema,
  reasonSchema,
  rejectConditionSchema,
  slotTimeSchema,
} from './orders.schema';
import { placeOrder } from './placement/placement.service';
import {
  getAllOrders,
  getOrderById,
  getOrdersForAdvertiser,
  getOrdersForAgent,
  getOrdersForPublisher,
} from './orders.queries';
import {
  adminAssignAgent,
  agentAcceptOrder,
  agentRejectOrder,
} from './assignment/assignment.service';
import {
  agentProposeSlot,
  publisherAcceptOrder,
  publisherConfirmSlot,
  publisherCounterSlot,
  publisherRejectOrder,
} from './scheduling/scheduling.service';
import {
  agentCaptureCondition,
  agentCaptureInstallation,
  agentCollectPrints,
  agentRejectCondition,
  markPrintReady,
} from './fulfilment/fulfilment.service';
import {
  selfInstallCaptureCondition,
  selfInstallCaptureInstallation,
  selfInstallCheckIn,
  selfInstallCollectPrints,
} from './fulfilment/self-install.service';
import {
  approveOrder,
  cancelOrder,
  endCampaign,
  requestCompletionOtp,
  verifyCompletionOtp,
} from './verification/verification.service';

const orderId = (req: Request) => req.params['id'] as string;

/** Runs a service call, translating its sentinel errors into the API envelope. */
async function respond<T>(res: Response, work: Promise<T>, status = 200): Promise<void> {
  try {
    res.status(status).json({ success: true, data: await work });
  } catch (e: any) {
    orderError(e);
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function placeOrderHandler(req: Request, res: Response): Promise<void> {
  const parsed = placeOrderSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  await respond(
    res,
    placeOrder({
      advertiserId: req.user!.sub,
      ...parsed.data,
      startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
    }),
    201,
  );
}

export async function getAllOrdersHandler(req: Request, res: Response): Promise<void> {
  const parsed = listOrdersQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  res.json({ success: true, data: await getAllOrders(parsed.data) });
}

/**
 * One endpoint, three different queries, chosen by the caller's role. An
 * advertiser sees orders they placed, a publisher sees orders on their
 * listings, an agent sees orders assigned to them. Roles are checked in that
 * order, so a user holding several sees the first that matches.
 */
export async function getMyOrdersHandler(req: Request, res: Response): Promise<void> {
  const roles = req.user!.roles;
  const userId = req.user!.sub;

  if (roles.includes('ADVERTISER')) {
    res.json({ success: true, data: await getOrdersForAdvertiser(userId) });
    return;
  }
  if (roles.includes('PUBLISHER')) {
    res.json({ success: true, data: await getOrdersForPublisher(userId) });
    return;
  }
  if (roles.includes('AGENT_PUBLISHER') || roles.includes('AGENT_ADVERTISER')) {
    const agent = await requireAgentProfile(userId);
    res.json({ success: true, data: await getOrdersForAgent(agent.id) });
    return;
  }

  throw new ApiError(403, 'FORBIDDEN', 'No order access for your role');
}

export async function getOrderByIdHandler(req: Request, res: Response): Promise<void> {
  const order = await getOrderById(orderId(req));
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  res.json({ success: true, data: order });
}

// ── Publisher response and slot negotiation ────────────────────────────────

export async function publisherAcceptHandler(req: Request, res: Response): Promise<void> {
  const { meetingPlace } = meetingPlaceSchema.parse(req.body);
  await respond(res, publisherAcceptOrder(orderId(req), req.user!.sub, meetingPlace));
}

export async function publisherRejectHandler(req: Request, res: Response): Promise<void> {
  const { reason } = reasonSchema.parse(req.body);
  await respond(res, publisherRejectOrder(orderId(req), req.user!.sub, reason));
}

export async function confirmSlotHandler(req: Request, res: Response): Promise<void> {
  await respond(res, publisherConfirmSlot(orderId(req), req.user!.sub));
}

export async function counterSlotHandler(req: Request, res: Response): Promise<void> {
  const { counterNote } = counterNoteSchema.parse(req.body);
  await respond(res, publisherCounterSlot(orderId(req), req.user!.sub, counterNote));
}

// ── Agent assignment and installation ──────────────────────────────────────

export async function agentAcceptHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  await respond(res, agentAcceptOrder(orderId(req), agent.id));
}

export async function agentRejectHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { reason } = reasonSchema.parse(req.body);
  await respond(res, agentRejectOrder(orderId(req), agent.id, reason));
}

export async function proposeSlotHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { slotTime } = slotTimeSchema.parse(req.body);
  await respond(res, agentProposeSlot(orderId(req), agent.id, new Date(slotTime)));
}

export async function collectPrintsHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { photoUrl } = photoUrlSchema.parse(req.body);
  await respond(res, agentCollectPrints(orderId(req), agent.id, photoUrl));
}

export async function captureConditionHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { photoUrls } = photoUrlsSchema.parse(req.body);
  await respond(res, agentCaptureCondition(orderId(req), agent.id, photoUrls));
}

export async function rejectConditionHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { reason, photoUrls } = rejectConditionSchema.parse(req.body);
  await respond(res, agentRejectCondition(orderId(req), agent.id, reason, photoUrls));
}

export async function captureInstallationHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { photoUrl } = photoUrlSchema.parse(req.body);
  await respond(res, agentCaptureInstallation(orderId(req), agent.id, photoUrl));
}

export async function requestOtpHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  await respond(res, requestCompletionOtp(orderId(req), agent.id));
}

export async function verifyOtpHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { otp } = completionOtpSchema.parse(req.body);
  await respond(res, verifyCompletionOtp(orderId(req), agent.id, otp));
}

// ── Publisher self-install ─────────────────────────────────────────────────

export async function selfInstallCollectPrintsHandler(req: Request, res: Response): Promise<void> {
  const { photoUrl } = photoUrlSchema.parse(req.body);
  await respond(res, selfInstallCollectPrints(orderId(req), req.user!.sub, photoUrl));
}

export async function selfInstallCaptureConditionHandler(req: Request, res: Response): Promise<void> {
  const { photoUrls } = photoUrlsSchema.parse(req.body);
  await respond(res, selfInstallCaptureCondition(orderId(req), req.user!.sub, photoUrls));
}

export async function selfInstallCheckInHandler(req: Request, res: Response): Promise<void> {
  await respond(res, selfInstallCheckIn(orderId(req), req.user!.sub));
}

export async function selfInstallCaptureInstallationHandler(req: Request, res: Response): Promise<void> {
  const { photoUrl } = photoUrlSchema.parse(req.body);
  await respond(res, selfInstallCaptureInstallation(orderId(req), req.user!.sub, photoUrl));
}

// ── Admin ──────────────────────────────────────────────────────────────────

export async function printReadyHandler(req: Request, res: Response): Promise<void> {
  await respond(res, markPrintReady(orderId(req)));
}

export async function adminAssignAgentHandler(req: Request, res: Response): Promise<void> {
  const { agentId } = agentIdSchema.parse(req.body);
  await respond(res, adminAssignAgent(orderId(req), agentId));
}

export async function approveOrderHandler(req: Request, res: Response): Promise<void> {
  await respond(res, approveOrder(orderId(req)));
}

export async function cancelOrderHandler(req: Request, res: Response): Promise<void> {
  const { reason } = reasonSchema.parse(req.body);
  await respond(res, cancelOrder(orderId(req), reason));
}

export async function endCampaignHandler(req: Request, res: Response): Promise<void> {
  await respond(res, endCampaign(orderId(req)));
}
