import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../../shared/audit';
import { missingPermissions } from '../../../shared/auth';
import { ApiError } from '../../../shared/errors';
import { riskReviewQuerySchema, type OrderRiskState } from '../../orders';
import { bulkSchema, confirmFraudSchema, holdSchema, noteSchema, type BulkAction } from './order-screening.schema';
import {
  cancelImpact,
  clearReview,
  confirmFraud,
  holdForReview,
  listFraudReview,
  openOrderFraudCase,
  releaseFromReview,
  screenOrder,
  type Actor,
  type ReviewChange,
} from './order-screening.service';

/*
 * Order fraud screening — the desk (2 Oct 2026). ADMIN + the fraud desk's
 * permissions at the router; every write audited by hand against the order:
 * ORDER_HELD, ORDER_RELEASED, ORDER_RISK_CLEARED, ORDER_CONFIRMED_FRAUD,
 * ORDER_RESCORED, and FRAUD_CASE_OPENED / ORDER_FRAUD_CASE_LINKED. The bulk
 * route runs the same acts one order at a time and audits each that landed.
 */

const actorOf = (req: Request): Actor => ({ sub: req.user!.sub, roles: req.user!.roles ?? [] });
const orderId = (req: Request) => req.params['id'] as string;
const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

/** The columns an act moves — what each audit row's diff compares. */
const AUDITED = ['status', 'riskReviewStatus', 'riskReviewNote', 'riskClearedSignalKeys', 'heldAt', 'heldById', 'holdReason', 'riskScore', 'riskBand', 'fraudCaseId'] as const;

async function audit(req: Request, action: string, id: string, change: ReviewChange, metadata: Record<string, unknown> = {}): Promise<void> {
  await logActivity(req.user!.sub, action, {
    req,
    module: 'fraud',
    targetType: 'Order',
    targetId: id,
    diff: auditDiff(change.before, change.after, AUDITED),
    metadata: { orderId: id, displayId: change.after.displayId, ...metadata },
  });
}

/** The answer to every single-order act: the order's screening state after it. */
const view = (state: OrderRiskState) => state;

/** GET /orders/fraud-review */
export async function listHandler(req: Request, res: Response): Promise<void> {
  const parsed = riskReviewQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listFraudReview(parsed.data) });
}

/** The four acts the single routes and the bulk route share — each runs the service and writes its audit row. */
const ACTS: Record<BulkAction, (req: Request, id: string, text: string | undefined) => Promise<{ after: OrderRiskState; extra?: Record<string, unknown> }>> = {
  async HOLD(req, id, text) {
    const change = await holdForReview(id, actorOf(req), text ?? '');
    await audit(req, 'ORDER_HELD', id, change, { reason: text, automatic: false });
    return { after: change.after };
  },
  async RELEASE(req, id, text) {
    const change = await releaseFromReview(id, actorOf(req), text);
    await audit(req, 'ORDER_RELEASED', id, change, { note: text ?? null });
    return { after: change.after };
  },
  async CLEAR(req, id, text) {
    const change = await clearReview(id, actorOf(req), text);
    await audit(req, 'ORDER_RISK_CLEARED', id, change, { note: text ?? null, clearedSignalKeys: change.after.riskClearedSignalKeys });
    return { after: change.after };
  },
  async CONFIRM_FRAUD(req, id, text) {
    const result = await confirmFraud(id, actorOf(req), text ?? '');
    await audit(req, 'ORDER_CONFIRMED_FRAUD', id, result, { reason: text, refunds: result.refunds });
    return { after: result.after, extra: { refunds: result.refunds } };
  },
};

/** POST /orders/:id/hold { reason } */
export async function holdHandler(req: Request, res: Response): Promise<void> {
  const parsed = holdSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { after } = await ACTS.HOLD(req, orderId(req), parsed.data.reason);
  res.json({ success: true, data: view(after) });
}

/** POST /orders/:id/release { note? } */
export async function releaseHandler(req: Request, res: Response): Promise<void> {
  const parsed = noteSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { after } = await ACTS.RELEASE(req, orderId(req), parsed.data.note);
  res.json({ success: true, data: view(after) });
}

/** POST /orders/:id/clear { note? } */
export async function clearHandler(req: Request, res: Response): Promise<void> {
  const parsed = noteSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { after } = await ACTS.CLEAR(req, orderId(req), parsed.data.note);
  res.json({ success: true, data: view(after) });
}

/** POST /orders/:id/confirm-fraud { reason } */
export async function confirmFraudHandler(req: Request, res: Response): Promise<void> {
  const parsed = confirmFraudSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { after, extra } = await ACTS.CONFIRM_FRAUD(req, orderId(req), parsed.data.reason);
  res.json({ success: true, data: { ...view(after), ...extra } });
}

/** GET /orders/:id/cancel-impact */
export async function cancelImpactHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await cancelImpact(orderId(req)) });
}

/** POST /orders/:id/fraud-case */
export async function fraudCaseHandler(req: Request, res: Response): Promise<void> {
  const id = orderId(req);
  const result = await openOrderFraudCase(id, actorOf(req));
  const fraudCase = { id: result.fraudCase.id, displayId: result.fraudCase.displayId, status: result.fraudCase.status };
  if (result.opened) {
    await logActivity(req.user!.sub, 'FRAUD_CASE_OPENED', {
      req,
      module: 'fraud',
      targetType: 'FraudCase',
      targetId: fraudCase.id,
      metadata: { caseId: fraudCase.id, displayId: fraudCase.displayId, subjectType: result.fraudCase.subjectType, subjectId: result.fraudCase.subjectId, kind: result.fraudCase.kind, orderId: id, source: 'order-review' },
    });
  }
  await audit(req, 'ORDER_FRAUD_CASE_LINKED', id, result, { caseId: fraudCase.id, caseDisplayId: fraudCase.displayId, opened: result.opened });
  res.status(result.opened ? 201 : 200).json({
    success: true,
    data: { fraudCaseId: fraudCase.id, fraudCase, order: view(result.after), opened: result.opened, attached: result.attached },
  });
}

/** POST /orders/:id/rescore */
export async function rescoreHandler(req: Request, res: Response): Promise<void> {
  const id = orderId(req);
  const result = (await screenOrder(id, { trigger: 'MANUAL' }))!;
  await audit(req, 'ORDER_RESCORED', id, result, { score: result.score.score.toFixed(3), band: result.score.band, held: result.held });
  res.json({ success: true, data: { ...view(result.after), held: result.held } });
}

/**
 * POST /orders/fraud-review/bulk { action, orderIds[], reason? } — one act
 * per order, in order, each its own audited write; a failure is that row's
 * `{ ok: false, code, message }` and the rest go on. Cancel as fraud needs
 * the orders cancel permission as well, asked once for the whole call.
 */
export async function bulkHandler(req: Request, res: Response): Promise<void> {
  const parsed = bulkSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { action, orderIds, reason } = parsed.data;
  if (action === 'CONFIRM_FRAUD') {
    const missing = missingPermissions(req.user, ['marketplace.edit']);
    if (missing.length) throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions', { missing });
  }
  const results: { id: string; ok: boolean; code?: string; message?: string }[] = [];
  for (const id of orderIds) {
    try {
      await ACTS[action](req, id, reason || undefined);
      results.push({ id, ok: true });
    } catch (err) {
      if (err instanceof ApiError) results.push({ id, ok: false, code: err.code, message: err.message });
      else results.push({ id, ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong with this order. Try it on its own.' });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  res.json({ success: true, data: { action, results, succeeded, failed: results.length - succeeded } });
}
