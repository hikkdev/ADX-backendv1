import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { closureReview } from './closure/closure-review';
import {
  decideClosureCase,
  listClosureCases,
  openClosureCase,
  requestOwnClosure,
} from './closure/closure.service';
import {
  approveErasure,
  executeErasure,
  listErasureRequests,
  openErasureFor,
  refuseErasure,
  requestErasure,
} from './erasure/erasure.service';
import {
  approveErasureSchema,
  closureCaseQuerySchema,
  closureRequestSchema,
  decideClosureSchema,
  erasureQuerySchema,
  idParamSchema,
  openClosureCaseSchema,
  ownErasureSchema,
  refuseErasureSchema,
  requestErasureSchema,
} from './account-lifecycle.schema';

/**
 * HTTP in, service out. No rules live here -- a closure that refuses does so
 * from the service, because the same refusal has to apply when the decision
 * comes off the queue rather than off a route.
 */

const invalid = (error: { flatten(): unknown }): ApiError =>
  new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

const idOf = (req: Request): string => parse(idParamSchema, req.params).id;

/* -- Closure ------------------------------------------------------- */

/** GET /users/:id/closure-review */
export async function closureReviewHandler(req: Request, res: Response): Promise<void> {
  const review = await closureReview(idOf(req));
  // `context` is the closure's own working set; the console does not draw it.
  const { context: _context, ...payload } = review;
  res.json({ success: true, data: payload });
}

/** POST /users/:id/closure-cases */
export async function openClosureCaseHandler(req: Request, res: Response): Promise<void> {
  const body = parse(openClosureCaseSchema, req.body);
  const result = await openClosureCase(idOf(req), {
    reason: body.reason,
    ticketId: body.ticketId,
    requestedById: req.user!.sub,
  });
  res.status(result.created ? 201 : 200).json({
    success: true,
    data: { case: result.case, summary: result.review.summary, blockers: result.review.blockers },
  });
}

/** POST /users/me/closure-request */
export async function requestOwnClosureHandler(req: Request, res: Response): Promise<void> {
  const body = parse(closureRequestSchema, req.body);
  const result = await requestOwnClosure(req.user!.sub, body.reason);
  res.status(result.created ? 201 : 200).json({
    success: true,
    data: { case: result.case, summary: result.review.summary },
  });
}

/** GET /users/closure-cases */
export async function listClosureCasesHandler(req: Request, res: Response): Promise<void> {
  const query = parse(closureCaseQuerySchema, req.query);
  res.json({ success: true, data: await listClosureCases(query) });
}

/** POST /users/closure-cases/:id/decide */
export async function decideClosureCaseHandler(req: Request, res: Response): Promise<void> {
  const body = parse(decideClosureSchema, req.body);
  const result = await decideClosureCase(
    idOf(req),
    { decision: body.decision, lossNote: body.lossNote },
    req.user!.sub,
  );
  res.json({ success: true, data: result });
}

/* -- Erasure ------------------------------------------------------- */

/** POST /users/:id/erasure */
export async function requestErasureHandler(req: Request, res: Response): Promise<void> {
  const body = parse(requestErasureSchema, req.body);
  const result = await requestErasure(idOf(req), {
    reason: body.reason,
    requestedVia: body.requestedVia,
  });
  res.status(result.created ? 201 : 200).json({ success: true, data: result.request });
}

/** E6: GET /users/:id/erasure — the open request, or null. */
export async function openErasureHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await openErasureFor(idOf(req)) });
}

/** POST /users/me/erasure */
export async function requestOwnErasureHandler(req: Request, res: Response): Promise<void> {
  const body = parse(ownErasureSchema, req.body);
  const result = await requestErasure(req.user!.sub, {
    reason: body.reason,
    requestedVia: 'APP',
  });
  res.status(result.created ? 201 : 200).json({ success: true, data: result.request });
}

/** GET /users/erasure */
export async function listErasureHandler(req: Request, res: Response): Promise<void> {
  const query = parse(erasureQuerySchema, req.query);
  res.json({ success: true, data: await listErasureRequests(query) });
}

/** POST /users/erasure/:id/approve */
export async function approveErasureHandler(req: Request, res: Response): Promise<void> {
  const body = parse(approveErasureSchema, req.body);
  res.json({ success: true, data: await approveErasure(idOf(req), body, req.user!.sub) });
}

/** POST /users/erasure/:id/refuse */
export async function refuseErasureHandler(req: Request, res: Response): Promise<void> {
  const body = parse(refuseErasureSchema, req.body);
  res.json({ success: true, data: await refuseErasure(idOf(req), body, req.user!.sub) });
}

/** POST /users/erasure/:id/execute */
export async function executeErasureHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await executeErasure(idOf(req), req.user!.sub) });
}
