import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import {
  addEvidenceSchema,
  addMessageSchema,
  queueQuerySchema,
  queueShape,
  raiseDisputeSchema,
  rateResolutionSchema,
  resolveSchema,
  setStatusSchema,
} from './disputes.schema';
import {
  addEvidence,
  addMessage,
  getVisibleDispute,
  listMine,
  listQueue,
  listQueuePage,
  raiseDispute,
  rateResolution,
  releaseCredit,
  reopen,
  resolve,
  setStatus,
  summary,
} from './disputes.service';
import type { Actor } from './disputes.types';

const actorOf = (req: Request): Actor => ({ sub: req.user!.sub, roles: req.user!.roles ?? [] });

const invalid = (error: { flatten(): unknown }) =>
  new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

// POST /disputes — any party to the order.
export async function raiseHandler(req: Request, res: Response): Promise<void> {
  const parsed = raiseDisputeSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const dispute = await raiseDispute(actor, parsed.data);
  await logActivity(actor.sub, 'DISPUTE_RAISED', req, { disputeId: dispute.id, orderId: dispute.orderId });
  res.status(201).json({ success: true, data: dispute });
}

// GET /disputes/my — the person's cases with the counts strip.
export async function mineHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listMine(actorOf(req)) });
}

// GET /disputes/:disputeId — raiser, the other party, or ADX.
export async function getHandler(req: Request, res: Response): Promise<void> {
  const dispute = await getVisibleDispute(req.params['disputeId'] as string, actorOf(req));
  if (!dispute) throw new ApiError(404, 'NOT_FOUND', 'Dispute not found');
  res.json({ success: true, data: dispute });
}

export async function messageHandler(req: Request, res: Response): Promise<void> {
  const parsed = addMessageSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const message = await addMessage(req.params['disputeId'] as string, actorOf(req), parsed.data.body);
  res.status(201).json({ success: true, data: message });
}

export async function evidenceHandler(req: Request, res: Response): Promise<void> {
  const parsed = addEvidenceSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const evidence = await addEvidence(req.params['disputeId'] as string, actorOf(req), parsed.data);
  res.status(201).json({ success: true, data: evidence });
}

export async function rateResolutionHandler(req: Request, res: Response): Promise<void> {
  const parsed = rateResolutionSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const actor = actorOf(req);
  const dispute = await rateResolution(req.params['disputeId'] as string, actor, parsed.data);
  await logActivity(actor.sub, 'DISPUTE_RESOLUTION_RATED', req, { disputeId: dispute.id, rating: parsed.data.rating });
  res.json({ success: true, data: dispute });
}

export async function reopenHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const dispute = await reopen(req.params['disputeId'] as string, actor);
  await logActivity(actor.sub, 'DISPUTE_REOPENED', req, { disputeId: dispute.id });
  res.json({ success: true, data: dispute });
}

/* ── ADMIN ───────────────────────────────────────────────────────── */

export async function queueHandler(req: Request, res: Response): Promise<void> {
  const parsed = queueQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { q, status } = parsed.data;
  const shape = queueShape(parsed.data);
  // E6: the list contract by default; the old bare array for a caller still
  // sending limit/offset, for one release.
  if (shape.legacy) {
    res.json({ success: true, data: await listQueue({ q, status, limit: shape.limit, offset: shape.offset }) });
    return;
  }
  res.json({ success: true, data: await listQueuePage({ q, status, page: shape.page, pageSize: shape.pageSize }) });
}

export async function summaryHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await summary() });
}

export async function statusHandler(req: Request, res: Response): Promise<void> {
  const parsed = setStatusSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const dispute = await setStatus(req.params['disputeId'] as string, actor, parsed.data.status, parsed.data.note);
  await logActivity(actor.sub, 'DISPUTE_STATUS_CHANGED', req, { disputeId: dispute.id, status: dispute.status });
  res.json({ success: true, data: dispute });
}

export async function resolveHandler(req: Request, res: Response): Promise<void> {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const dispute = await resolve(req.params['disputeId'] as string, actor, parsed.data);
  await logActivity(actor.sub, 'DISPUTE_RESOLVED', {
    req,
    module: 'disputes',
    targetType: 'Dispute',
    targetId: dispute.id,
    diff: auditDiff({ status: 'OPEN', outcome: null }, { status: dispute.status, outcome: dispute.outcome }),
    metadata: {
      disputeId: dispute.id,
      outcome: dispute.outcome,
      creditedAmount: dispute.creditedAmount,
      reinstallMilestoneId: dispute.reinstallMilestoneId ?? null,
    },
  });
  res.json({ success: true, data: dispute });
}

export async function releaseCreditHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const dispute = await releaseCredit(req.params['disputeId'] as string, actor);
  await logActivity(actor.sub, 'DISPUTE_CREDIT_RELEASED', req, {
    disputeId: dispute.id,
    creditedAmount: dispute.creditedAmount,
  });
  res.json({ success: true, data: dispute });
}
