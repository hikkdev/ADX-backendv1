import type { Request, Response } from 'express';
import { z } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { findAgentProfile, requireAgentProfile } from '../agents';
import { orderError } from './orders.errors';
import {
  adminCancelSchema,
  agentIdSchema,
  attestationSchema,
  chooseFulfilmentSchema,
  completionOtpSchema,
  conditionPhotosSchema,
  counterNoteSchema,
  installationPhotoSchema,
  adminOrdersQuerySchema,
  calendarQuerySchema,
  myOrdersQuerySchema,
  meetingPlaceSchema,
  optionalPhotoUrlSchema,
  opsAcceptPublisherSchema,
  opsReasonSchema,
  reassignAgentSchema,
  collectPrintsSchema,
  photoUrlSchema,
  photoUrlsSchema,
  placeOrderSchema,
  printReadySchema,
  reasonSchema,
  agentRejectSchema,
  rejectConditionSchema,
  selfCheckInSchema,
  slotTimeSchema,
} from './orders.schema';
import { placeOrder } from './placement/placement.service';
import {
  getAllOrders,
  getBookingCalendar,
  getOrderById,
  getOrderSummary,
  getOrdersForAdvertiser,
  getOrdersForAgent,
  getOrdersForPublisher,
} from './orders.queries';
import {
  adminAssignAgent,
  agentAcceptOrder,
  agentOfferHistory,
  agentRejectOrder,
  reassignAgent,
} from './assignment/assignment.service';
import { opsAcceptPublisher, opsCollectPrints, opsConfirmSlot, type OpsOverride } from './ops/ops.service';

/** GET /orders/agents/:agentId/offers — the coded reasons, counted, for the console's agent page. */
export async function agentOffersHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await agentOfferHistory(req.params['agentId'] as string) });
}
import { rejectionText } from './assignment/rejection-reasons';
import {
  agentProposeSlot,
  agentSlotCandidates,
  publisherAcceptOrder,
  publisherConfirmSlot,
  publisherCounterSlot,
  publisherRejectOrder,
} from './scheduling/scheduling.service';
import {
  agentCaptureCondition,
  agentCaptureInstallation,
  agentCollectPrints,
  agentSubmitInstallation,
  fulfilmentEvidence,
  agentRejectCondition,
  markPrintReady,
  pickupCode,
  publisherChooseFulfilment,
} from './fulfilment/fulfilment.service';
import { jobLadder } from './fulfilment/job-ladder';
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

/** The same translation, for a handler that has something to do with the result before answering. */
async function attempt<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e: any) {
    return orderError(e);
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
  const parsed = adminOrdersQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  res.json({ success: true, data: await getAllOrders(parsed.data) });
}

/** Lot G (Q114): the booking calendar — ACTIVE listings first, the window's orders on each. */
export async function bookingCalendarHandler(req: Request, res: Response): Promise<void> {
  const parsed = calendarQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await getBookingCalendar(parsed.data) });
}

/**
 * One endpoint, three different queries, chosen by the caller's role. An
 * advertiser sees orders they placed, a publisher sees orders on their
 * listings, an agent sees orders assigned to them. A user holding several sees
 * the first that matches.
 *
 * Publisher wins, because that is the account the apps show. Somebody who both
 * owns a spot and buys advertising lands on `PublisherHome` (user-app
 * App.tsx) — the supply side is the one with inventory to look after — and
 * this used to answer that screen with the advertiser's own orders, so a
 * dual-role account opened Bookings and found campaigns it had bought sitting
 * in the list of jobs on its spots.
 *
 * Reconciled here rather than in the app: the client's precedence is the one a
 * person sees. A screen that wants the *other* list asks for it by name —
 * `?as=advertiser` — and is refused, not defaulted, when the caller does not
 * hold that role: a client asking for a list it cannot have is a bug worth
 * surfacing rather than a preference to guess at. Without `as`, the
 * precedence below stands.
 */
export async function getMyOrdersHandler(req: Request, res: Response): Promise<void> {
  const parsed = myOrdersQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const roles = req.user!.roles;
  const userId = req.user!.sub;
  const as = parsed.data.as;
  const query = parsed.data;

  if (as === 'advertiser') {
    if (!roles.includes('ADVERTISER')) throw new ApiError(403, 'FORBIDDEN', 'You are not an advertiser');
    res.json({ success: true, data: await getOrdersForAdvertiser(userId, query) });
    return;
  }
  if (as === 'publisher') {
    if (!roles.includes('PUBLISHER')) throw new ApiError(403, 'FORBIDDEN', 'You are not a publisher');
    res.json({ success: true, data: await getOrdersForPublisher(userId, query) });
    return;
  }
  if (as === 'agent') {
    if (!roles.includes('AGENT_PUBLISHER') && !roles.includes('AGENT_ADVERTISER')) {
      throw new ApiError(403, 'FORBIDDEN', 'You are not an agent');
    }
    const agent = await requireAgentProfile(userId);
    res.json({ success: true, data: await getOrdersForAgent(agent.id, query) });
    return;
  }

  if (roles.includes('PUBLISHER')) {
    res.json({ success: true, data: await getOrdersForPublisher(userId, query) });
    return;
  }
  if (roles.includes('ADVERTISER')) {
    res.json({ success: true, data: await getOrdersForAdvertiser(userId, query) });
    return;
  }
  if (roles.includes('AGENT_PUBLISHER') || roles.includes('AGENT_ADVERTISER')) {
    const agent = await requireAgentProfile(userId);
    res.json({ success: true, data: await getOrdersForAgent(agent.id, query) });
    return;
  }

  throw new ApiError(403, 'FORBIDDEN', 'No order access for your role');
}

export async function getOrderByIdHandler(req: Request, res: Response): Promise<void> {
  const order = await getOrderById(orderId(req));
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (!(await canReadOrder(order as unknown as ReadableOrder, req.user!))) {
    // 403 rather than 404, matching orders.errors' NOT_YOUR_ORDER: the id is a
    // cuid nobody guesses, so admitting it exists costs nothing, and a
    // wrong-account bug in an app is far easier to find as "no access" than
    // as "not found".
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this order');
  }
  res.json({ success: true, data: order });
}

/** The slice of the detail aggregate that decides who may read it. */
type ReadableOrder = {
  advertiserId: string;
  agentId: string | null;
  listing?: { publisher?: { userId: string } | null } | null;
  agentAssignments?: { agentId: string }[];
};

/**
 * Who may read an order: ADX; the advertiser who placed it; the publisher
 * whose listing it books; the agent holding it; and an agent it has been
 * offered to, who has to read the job before they can accept it.
 *
 * Until this existed the route was `authenticate` and nothing else, so any
 * signed-in user could read any order by id — the publisher's name, mobile
 * and address included. The detail aggregate is the widest read in the
 * codebase, which is exactly why it needed the narrowest gate.
 */
async function canReadOrder(
  order: ReadableOrder,
  user: { sub: string; roles: string[] },
): Promise<boolean> {
  if (user.roles.includes('ADMIN')) return true;
  if (order.advertiserId === user.sub) return true;
  if (order.listing?.publisher?.userId === user.sub) return true;

  if (user.roles.includes('AGENT_PUBLISHER') || user.roles.includes('AGENT_ADVERTISER')) {
    const agent = await findAgentProfile(user.sub);
    if (!agent) return false;
    if (order.agentId === agent.id) return true;
    if (order.agentAssignments?.some((assignment) => assignment.agentId === agent.id)) return true;
  }
  return false;
}

// ── Publisher response and slot negotiation ────────────────────────────────

export async function publisherAcceptHandler(req: Request, res: Response): Promise<void> {
  const { meetingPlace } = meetingPlaceSchema.parse(req.body);
  await respond(res, publisherAcceptOrder(orderId(req), req.user!.sub, meetingPlace));
}

export async function submitInstallationHandler(req: Request, res: Response): Promise<void> {
  const { attested } = attestationSchema.parse(req.body ?? {});
  const agent = await requireAgentProfile(req.user!.sub);
  await respond(res, agentSubmitInstallation(orderId(req), agent.id, { attested }));
}

/** What the submit gate has, and what it is still waiting for. */
export async function evidenceHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await fulfilmentEvidence(orderId(req)) });
}

/**
 * GET /orders/job-ladder — Lot G (Q126/Q141): the A1–A8 checklist the agent
 * app draws, as data. The stored `flows.agent-job` when it fits the
 * vocabulary, the code ladder otherwise; `source` says which.
 */
export async function jobLadderHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await jobLadder() });
}

export async function publisherRejectHandler(req: Request, res: Response): Promise<void> {
  const { reason } = reasonSchema.parse(req.body);
  await respond(res, publisherRejectOrder(orderId(req), req.user!.sub, reason));
}

/** P2 — the publisher says who installs this one. */
export async function chooseFulfilmentHandler(req: Request, res: Response): Promise<void> {
  const { installBy } = chooseFulfilmentSchema.parse(req.body);
  await respond(res, publisherChooseFulfilment(orderId(req), req.user!.sub, installBy));
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
  // Lot D (Q123): the tap records the agent's JOB_TERMS acceptance with its provenance.
  await respond(
    res,
    agentAcceptOrder(orderId(req), agent.id, { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null }),
  );
}

export async function agentRejectHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  // A8: one of the five drawn reasons, with words when it is "Other".
  const parsed = agentRejectSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Pick a reason', parsed.error.flatten());
  await respond(res, agentRejectOrder(orderId(req), agent.id, rejectionText(parsed.data.reason, parsed.data.note)));
}

/** A7 — the times the drawn picker offers. */
export async function slotCandidatesHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  await respond(res, agentSlotCandidates(orderId(req), agent.id));
}

export async function proposeSlotHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { slotTime } = slotTimeSchema.parse(req.body);
  await respond(res, agentProposeSlot(orderId(req), agent.id, new Date(slotTime)));
}

export async function collectPrintsHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { photoUrl, qrId } = collectPrintsSchema.parse(req.body ?? {});
  await respond(res, agentCollectPrints(orderId(req), agent.id, photoUrl, qrId));
}

/**
 * A9 — the pickup code: ADX prints it on the package, the holding agent may
 * look it up. Anyone else is refused before the order is even read.
 */
export async function pickupCodeHandler(req: Request, res: Response): Promise<void> {
  const roles = req.user?.roles ?? [];
  if (!roles.includes('ADMIN')) {
    const agent = await requireAgentProfile(req.user!.sub);
    const order = await getOrderSummary(orderId(req));
    if (!order || order.agentId !== agent.id) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this order');
  }
  await respond(res, pickupCode(orderId(req)));
}

export async function captureConditionHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  // Labels ride along with the photos. The service has taken them since the
  // photo table replaced the two columns; only this parse was dropping them, so
  // every shot was arriving at the database anonymous.
  const { photoUrls, labels } = conditionPhotosSchema.parse(req.body);
  await respond(res, agentCaptureCondition(orderId(req), agent.id, photoUrls, labels ?? []));
}

export async function rejectConditionHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { reason, photoUrls } = rejectConditionSchema.parse(req.body);
  await respond(res, agentRejectCondition(orderId(req), agent.id, reason, photoUrls));
}

export async function captureInstallationHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const { photoUrl, label } = installationPhotoSchema.parse(req.body);
  await respond(res, agentCaptureInstallation(orderId(req), agent.id, photoUrl, label ?? null));
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
  // The body used to be parsed nowhere, so the coordinates and token the app
  // has always sent were dropped on the floor.
  const at = selfCheckInSchema.parse(req.body ?? {});
  await respond(res, selfInstallCheckIn(orderId(req), req.user!.sub, at));
}

export async function selfInstallCaptureInstallationHandler(req: Request, res: Response): Promise<void> {
  const { photoUrl } = photoUrlSchema.parse(req.body);
  await respond(res, selfInstallCaptureInstallation(orderId(req), req.user!.sub, photoUrl));
}

// ── Admin ──────────────────────────────────────────────────────────────────

/*
 * The three admin writes below are audited by hand (Lot A) because each moves
 * money or status: the per-order installation figure ops typed (Q102), the
 * offer it was quoted on, and the sign-off that records the commission.
 */

export async function printReadyHandler(req: Request, res: Response): Promise<void> {
  const { agentFee } = printReadySchema.parse(req.body ?? {});
  const id = orderId(req);
  const updated = await attempt(markPrintReady(id, { agentFee }));
  await logActivity(req.user!.sub, 'ORDER_PRINT_READY', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff(
      { status: 'PENDING_PRINT', agentFeeAmount: null },
      { status: updated.status, agentFeeAmount: updated.agentFeeAmount },
    ),
  });
  res.json({ success: true, data: updated });
}

export async function adminAssignAgentHandler(req: Request, res: Response): Promise<void> {
  const { agentId, agentFee } = agentIdSchema.parse(req.body);
  const id = orderId(req);
  const updated = await attempt(adminAssignAgent(id, agentId, { agentFee }));
  await logActivity(req.user!.sub, 'ORDER_AGENT_ASSIGNED', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff({ agentId: null }, { agentId }),
    metadata: { agentId, ...(agentFee !== undefined ? { agentFee } : {}) },
  });
  res.json({ success: true, data: updated });
}

export async function approveOrderHandler(req: Request, res: Response): Promise<void> {
  const id = orderId(req);
  const approved = await attempt(approveOrder(id));
  await logActivity(req.user!.sub, 'ORDER_APPROVED', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff({ status: 'PENDING_APPROVAL' }, { status: approved.status }),
    metadata: {
      agentId: approved.agentId,
      incentiveId: approved.incentive?.id ?? null,
      incentiveAmount: approved.incentive?.amount ?? null,
    },
  });
  res.json({ success: true, data: approved });
}

/** Lot D (Q51): the reason is mandatory and written on the order, beside who and when. */
export async function cancelOrderHandler(req: Request, res: Response): Promise<void> {
  const { reason } = adminCancelSchema.parse(req.body ?? {});
  const id = orderId(req);
  const before = await getOrderSummary(id);
  const cancelled = await attempt(cancelOrder(id, reason, req.user!.sub));
  await logActivity(req.user!.sub, 'ORDER_CANCELLED', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff({ status: before?.status ?? null }, { status: cancelled.status }),
    metadata: { reason },
  });
  res.json({ success: true, data: cancelled });
}

export async function endCampaignHandler(req: Request, res: Response): Promise<void> {
  const id = orderId(req);
  const ended = await attempt(endCampaign(id));
  await logActivity(req.user!.sub, 'ORDER_CAMPAIGN_ENDED', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    metadata: { endDate: ended.endDate },
  });
  res.json({ success: true, data: ended });
}

// ── Lot D (Q51/Q90): the ops moves ─────────────────────────────────────────

/**
 * POST /orders/:id/reassign-agent — the order to another agent, from any
 * state before the proof. Audited with both agents in the diff.
 */
export async function reassignAgentHandler(req: Request, res: Response): Promise<void> {
  const { agentId, reason } = reassignAgentSchema.parse(req.body ?? {});
  const id = orderId(req);
  const before = await getOrderSummary(id);
  const updated = await attempt(reassignAgent(id, agentId, reason));
  await logActivity(req.user!.sub, 'ORDER_AGENT_REASSIGNED', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff(
      { agentId: before?.agentId ?? null, status: before?.status ?? null },
      { agentId, status: updated?.status ?? null },
    ),
    metadata: { reason, previousAgentId: before?.agentId ?? null, agentId },
  });
  res.json({ success: true, data: updated });
}

/**
 * The three overrides that stand in for a party who is not answering. One
 * audit action, `ORDER_OPS_OVERRIDE`, with the step named, so the trail for
 * an order lists every time ADX acted for somebody.
 */
async function opsOverride(
  req: Request,
  res: Response,
  step: OpsOverride,
  work: (id: string) => Promise<{ status: string } | null | undefined>,
  metadata: Record<string, unknown>,
): Promise<void> {
  const id = orderId(req);
  const before = await getOrderSummary(id);
  const updated = await attempt(work(id));
  await logActivity(req.user!.sub, 'ORDER_OPS_OVERRIDE', {
    req,
    module: 'orders',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff({ status: before?.status ?? null }, { status: updated?.status ?? null }),
    metadata: { step, ...metadata },
  });
  res.json({ success: true, data: updated });
}

export async function opsAcceptPublisherHandler(req: Request, res: Response): Promise<void> {
  const input = opsAcceptPublisherSchema.parse(req.body ?? {});
  await opsOverride(req, res, 'ACCEPT_PUBLISHER', (id) => opsAcceptPublisher(id, input), input);
}

export async function opsConfirmSlotHandler(req: Request, res: Response): Promise<void> {
  const input = opsReasonSchema.parse(req.body ?? {});
  await opsOverride(req, res, 'CONFIRM_SLOT', (id) => opsConfirmSlot(id, input), input);
}

export async function opsCollectPrintsHandler(req: Request, res: Response): Promise<void> {
  const input = opsReasonSchema.parse(req.body ?? {});
  await opsOverride(req, res, 'COLLECT_PRINTS', (id) => opsCollectPrints(id, input), input);
}
