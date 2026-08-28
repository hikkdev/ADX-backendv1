import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { prisma } from '../shared/database';
import {
  placeOrder, publisherAcceptOrder, publisherRejectOrder, markPrintReady,
  agentAcceptOrder, agentRejectOrder, agentProposeSlot,
  publisherConfirmSlot, publisherCounterSlot,
  agentCollectPrints, agentCaptureCondition, agentRejectCondition,
  agentCaptureInstallation, requestCompletionOtp, verifyCompletionOtp,
  approveOrder, cancelOrder, endCampaign, adminAssignAgent,
  getOrderById, getAllOrders, getSimilarListings,
  getOrdersForAdvertiser, getOrdersForPublisher, getOrdersForAgent,
  selfInstallCollectPrints, selfInstallCaptureCondition, selfInstallCheckIn, selfInstallCaptureInstallation,
} from '../services/order.service';

function svcErr(e: any): never {
  const map: Record<string, [number, string]> = {
    ORDER_NOT_FOUND:       [404, 'Order not found'],
    LISTING_NOT_FOUND:     [404, 'Listing not found'],
    LISTING_NOT_ACTIVE:    [400, 'Listing is not active'],
    LISTING_NOT_AVAILABLE: [400, 'Listing is currently occupied by an active campaign'],
    NOT_YOUR_ORDER:        [403, 'You do not have access to this order'],
    WRONG_STATUS:          [400, 'Order is not in the required state for this action'],
    ASSIGNMENT_NOT_FOUND:  [404, 'No pending assignment for you on this order'],
    OTP_NOT_REQUESTED:     [400, 'OTP has not been requested yet'],
    OTP_EXPIRED:           [400, 'OTP expired. Request a new one.'],
    OTP_INVALID:           [400, 'Invalid OTP'],
    ALREADY_COMPLETED:     [400, 'Cannot cancel a completed order'],
    COUNTER_LIMIT_REACHED: [400, 'Max slot negotiations reached. Escalated to sales team.'],
  };
  const entry = map[e?.message];
  if (entry) {
    const [statusCode, message] = entry;
    if (statusCode === 404) throw new ApiError(404, 'NOT_FOUND', message);
    if (statusCode === 403) throw new ApiError(403, 'FORBIDDEN', message);
    throw new ApiError(statusCode, 'BAD_REQUEST', message);
  }
  throw e;
}

async function resolveAgent(userId: string) {
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return agent;
}

export async function placeOrderHandler(req: Request, res: Response): Promise<void> {
  const schema = z.object({
    listingId: z.string().min(1),
    campaignName: z.string().optional(),
    designUrl: z.string().url().optional(),
    budget: z.number().positive().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  try {
    const order = await placeOrder({
      advertiserId: req.user!.sub,
      ...parsed.data,
      startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
    });
    res.status(201).json({ success: true, data: order });
  } catch (e: any) { svcErr(e); }
}

export async function getAllOrdersHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    status: z.string().optional(),
    limit: z.coerce.number().default(50),
    offset: z.coerce.number().default(0),
  }).safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const orders = await getAllOrders(parsed.data);
  res.json({ success: true, data: orders });
}

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
    const agent = await resolveAgent(userId);
    res.json({ success: true, data: await getOrdersForAgent(agent.id) });
    return;
  }
  throw new ApiError(403, 'FORBIDDEN', 'No order access for your role');
}

export async function getOrderByIdHandler(req: Request, res: Response): Promise<void> {
  const order = await getOrderById(req.params['id'] as string);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  res.json({ success: true, data: order });
}

export async function publisherAcceptHandler(req: Request, res: Response): Promise<void> {
  const { meetingPlace } = z.object({ meetingPlace: z.string().min(1) }).parse(req.body);
  try {
    res.json({ success: true, data: await publisherAcceptOrder(req.params['id'] as string, req.user!.sub, meetingPlace) });
  } catch (e: any) { svcErr(e); }
}

export async function publisherRejectHandler(req: Request, res: Response): Promise<void> {
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);
  try {
    res.json({ success: true, data: await publisherRejectOrder(req.params['id'] as string, req.user!.sub, reason) });
  } catch (e: any) { svcErr(e); }
}

export async function printReadyHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await markPrintReady(req.params['id'] as string) });
  } catch (e: any) { svcErr(e); }
}

export async function adminAssignAgentHandler(req: Request, res: Response): Promise<void> {
  const { agentId } = z.object({ agentId: z.string().min(1) }).parse(req.body);
  try {
    res.json({ success: true, data: await adminAssignAgent(req.params['id'] as string, agentId) });
  } catch (e: any) { svcErr(e); }
}

export async function agentAcceptHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  try {
    res.json({ success: true, data: await agentAcceptOrder(req.params['id'] as string, agent.id) });
  } catch (e: any) { svcErr(e); }
}

export async function agentRejectHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);
  try {
    res.json({ success: true, data: await agentRejectOrder(req.params['id'] as string, agent.id, reason) });
  } catch (e: any) { svcErr(e); }
}

export async function proposeSlotHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { slotTime } = z.object({ slotTime: z.string().datetime() }).parse(req.body);
  try {
    res.json({ success: true, data: await agentProposeSlot(req.params['id'] as string, agent.id, new Date(slotTime)) });
  } catch (e: any) { svcErr(e); }
}

export async function confirmSlotHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await publisherConfirmSlot(req.params['id'] as string, req.user!.sub) });
  } catch (e: any) { svcErr(e); }
}

export async function counterSlotHandler(req: Request, res: Response): Promise<void> {
  const { counterNote } = z.object({ counterNote: z.string().optional() }).parse(req.body);
  try {
    res.json({ success: true, data: await publisherCounterSlot(req.params['id'] as string, req.user!.sub, counterNote) });
  } catch (e: any) { svcErr(e); }
}

export async function collectPrintsHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { photoUrl } = z.object({ photoUrl: z.string().url() }).parse(req.body);
  try {
    res.json({ success: true, data: await agentCollectPrints(req.params['id'] as string, agent.id, photoUrl) });
  } catch (e: any) { svcErr(e); }
}

export async function captureConditionHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { photoUrls } = z.object({ photoUrls: z.array(z.string().url()).min(1) }).parse(req.body);
  try {
    res.json({ success: true, data: await agentCaptureCondition(req.params['id'] as string, agent.id, photoUrls) });
  } catch (e: any) { svcErr(e); }
}

export async function rejectConditionHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { reason, photoUrls } = z.object({
    reason: z.string().min(1),
    photoUrls: z.array(z.string().url()).min(1),
  }).parse(req.body);
  try {
    res.json({ success: true, data: await agentRejectCondition(req.params['id'] as string, agent.id, reason, photoUrls) });
  } catch (e: any) { svcErr(e); }
}

export async function captureInstallationHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { photoUrl } = z.object({ photoUrl: z.string().url() }).parse(req.body);
  try {
    res.json({ success: true, data: await agentCaptureInstallation(req.params['id'] as string, agent.id, photoUrl) });
  } catch (e: any) { svcErr(e); }
}

export async function requestOtpHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  try {
    res.json({ success: true, data: await requestCompletionOtp(req.params['id'] as string, agent.id) });
  } catch (e: any) { svcErr(e); }
}

export async function verifyOtpHandler(req: Request, res: Response): Promise<void> {
  const agent = await resolveAgent(req.user!.sub);
  const { otp } = z.object({ otp: z.string().length(6) }).parse(req.body);
  try {
    res.json({ success: true, data: await verifyCompletionOtp(req.params['id'] as string, agent.id, otp) });
  } catch (e: any) { svcErr(e); }
}

export async function approveOrderHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await approveOrder(req.params['id'] as string) });
  } catch (e: any) { svcErr(e); }
}

export async function cancelOrderHandler(req: Request, res: Response): Promise<void> {
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body);
  try {
    res.json({ success: true, data: await cancelOrder(req.params['id'] as string, reason) });
  } catch (e: any) { svcErr(e); }
}

export async function endCampaignHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await endCampaign(req.params['id'] as string) });
  } catch (e: any) { svcErr(e); }
}

export async function similarListingsHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getSimilarListings(req.params['id'] as string) });
  } catch (e: any) { svcErr(e); }
}

export async function selfInstallCollectPrintsHandler(req: Request, res: Response): Promise<void> {
  const schema = z.object({ photoUrl: z.string().url() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'photoUrl required');
  try {
    const order = await selfInstallCollectPrints(req.params['id'] as string, req.user!.sub, parsed.data.photoUrl);
    res.json({ success: true, data: order });
  } catch (e) { svcErr(e); }
}

export async function selfInstallCaptureConditionHandler(req: Request, res: Response): Promise<void> {
  const schema = z.object({ photoUrls: z.array(z.string().url()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'photoUrls required');
  try {
    const order = await selfInstallCaptureCondition(req.params['id'] as string, req.user!.sub, parsed.data.photoUrls);
    res.json({ success: true, data: order });
  } catch (e) { svcErr(e); }
}

export async function selfInstallCheckInHandler(req: Request, res: Response): Promise<void> {
  try {
    const order = await selfInstallCheckIn(req.params['id'] as string, req.user!.sub);
    res.json({ success: true, data: order });
  } catch (e) { svcErr(e); }
}

export async function selfInstallCaptureInstallationHandler(req: Request, res: Response): Promise<void> {
  const schema = z.object({ photoUrl: z.string().url() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'photoUrl required');
  try {
    const order = await selfInstallCaptureInstallation(req.params['id'] as string, req.user!.sub, parsed.data.photoUrl);
    res.json({ success: true, data: order });
  } catch (e) { svcErr(e); }
}

export async function agentCheckInHandler(req: Request, res: Response): Promise<void> {
  const schema = z.object({
    latitude: z.number(),
    longitude: z.number(),
    qrToken: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'latitude, longitude and qrToken required');
  const agent = await resolveAgent(req.user!.sub);
  const orderId = req.params['id'] as string;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this order');
  if (order.listing.qrToken !== parsed.data.qrToken) throw new ApiError(400, 'INVALID_QR', 'QR code does not match this listing');

  // Calculate distance from listing location
  const lat1 = parsed.data.latitude;
  const lon1 = parsed.data.longitude;
  const lat2 = order.listing.latitude ?? lat1;
  const lon2 = order.listing.longitude ?? lon1;
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const distanceM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const checkIn = await prisma.checkIn.upsert({
    where: { orderId },
    create: {
      orderId,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      distanceM,
    },
    update: {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      distanceM,
      checkedInAt: new Date(),
    },
  });
  res.json({ success: true, data: { checkIn, order } });
}

export async function updateLocationHandler(req: Request, res: Response): Promise<void> {
  const schema = z.object({
    latitude: z.number(),
    longitude: z.number(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude required');
  await prisma.order.update({
    where: { id: req.params['id'] as string },
    data: {
      agentLatitude: parsed.data.latitude,
      agentLongitude: parsed.data.longitude,
      agentLocationUpdatedAt: new Date(),
    },
  });
  res.json({ success: true });
}

export async function agentLocationHandler(req: Request, res: Response): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: req.params['id'] as string },
    select: { agentLatitude: true, agentLongitude: true, agentLocationUpdatedAt: true },
  });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  res.json({
    success: true,
    data: {
      latitude: order.agentLatitude,
      longitude: order.agentLongitude,
      updatedAt: order.agentLocationUpdatedAt,
    },
  });
}
