import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { upperEnum } from '../../shared/validation';

/**
 * What a closure or an erasure request may say.
 *
 * The reason is required everywhere and bounded on both ends, for the same
 * rule the suspension module keeps: a decision with no stated reason is not
 * reviewable six months later, and both of these are decisions somebody will
 * be asked to justify.
 */

export const reasonSchema = z.string().trim().min(3).max(500);

export const idParamSchema = z.object({ id: z.string().trim().min(1).max(64) });

/* -- Closure ------------------------------------------------------- */

export const openClosureCaseSchema = z.object({
  reason: reasonSchema,
  /** An existing support thread this case belongs to, when ops raised it from one. */
  ticketId: z.string().trim().min(1).max(64).optional(),
});
export type OpenClosureCaseInput = z.infer<typeof openClosureCaseSchema>;

export const closureRequestSchema = z.object({ reason: reasonSchema });

export const CLOSURE_DECISIONS = ['PENDING', 'CLOSED', 'REFUSED'] as const;
/** What an admin may actually decide. PENDING is a state, not a decision. */
export const CLOSURE_VERDICTS = ['CLOSED', 'REFUSED'] as const;

export const decideClosureSchema = z.object({
  decision: upperEnum(CLOSURE_VERDICTS),
  /**
   * Money ADX is writing off rather than paying out. Its presence is what
   * stops the closure raising a final withdrawal -- see closure.service.
   */
  lossNote: z.string().trim().min(3).max(1000).optional(),
});
export type DecideClosureInput = z.infer<typeof decideClosureSchema>;

const closureListSchema = listQuerySchema(CLOSURE_DECISIONS, ['newest'] as const);

/**
 * `?decision=&q=&page=&pageSize=`.
 *
 * The shared list contract takes `status` as a comma list; this queue filters
 * on one decision at a time, which is what the console's chip row does, so the
 * facet is named for what it is and narrowed to a single value.
 */
export const closureCaseQuerySchema = closureListSchema
  .omit({ status: true, sort: true })
  .extend({ decision: upperEnum(CLOSURE_DECISIONS).optional() });

export type ClosureCaseQuery = z.infer<typeof closureCaseQuerySchema>;

/* -- Erasure ------------------------------------------------------- */

export const ERASURE_STATUSES = ['PENDING', 'APPROVED', 'DONE', 'REFUSED'] as const;
export const ERASURE_VIA = ['APP', 'EMAIL', 'OPS'] as const;

export const requestErasureSchema = z.object({
  reason: reasonSchema.optional(),
  requestedVia: upperEnum(ERASURE_VIA).default('OPS'),
});
export type RequestErasureInput = z.infer<typeof requestErasureSchema>;

/** The self-service half: the channel is known from the route, so it is not asked. */
export const ownErasureSchema = z.object({ reason: reasonSchema.optional() });

export const approveErasureSchema = z.object({
  /** Who signed it. Kept on the row because "the DPO approved it" is not a record. */
  dpoName: z.string().trim().min(2).max(120),
});
export type ApproveErasureInput = z.infer<typeof approveErasureSchema>;

export const refuseErasureSchema = z.object({ reason: reasonSchema });

export const erasureQuerySchema = listQuerySchema(ERASURE_STATUSES, ['newest'] as const)
  .omit({ status: true, sort: true })
  .extend({ status: upperEnum(ERASURE_STATUSES).optional() });

export type ErasureQuery = z.infer<typeof erasureQuerySchema>;
