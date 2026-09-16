import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';

/** POST /disputes/:id/rate — the raiser's score of how the case was handled. */
export const rateResolutionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  note: z.string().trim().max(500).optional(),
});
import { DISPUTE_OUTCOMES, DISPUTE_REASONS, DISPUTE_STATUSES, OPS_MOVABLE_STATUSES } from './disputes.types';

/** A rupee amount as the platform carries money: a decimal string, two places at most. */
export const moneyStringSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use a plain amount like 450 or 450.50')
  .refine((value) => Number(value) > 0, 'The amount must be more than zero');

const evidenceItemSchema = z.object({
  url: z.string().url().max(2048),
  kind: z.enum(['IMG', 'PDF', 'OTHER']).default('IMG'),
  fileName: z.string().trim().max(200).optional(),
});

/** Raising a case: the Raise frame, field for field. */
export const raiseDisputeSchema = z.object({
  orderId: z.string().min(1),
  reason: z.enum(DISPUTE_REASONS),
  detail: z.string().trim().min(10, 'Describe what happened in a few more words').max(4000),
  expectedResolution: z.string().trim().max(200).optional(),
  amountClaimed: moneyStringSchema.optional(),
  evidence: z.array(evidenceItemSchema).max(5).default([]),
});

export const addMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const addEvidenceSchema = evidenceItemSchema;

/** Ops moving a case by hand. Closing goes through resolve. */
export const setStatusSchema = z.object({
  status: z.enum(OPS_MOVABLE_STATUSES),
  note: z.string().trim().min(1, 'Say why — it goes on the case record').max(2000),
});

export const resolveSchema = z
  .object({
    outcome: z.enum(DISPUTE_OUTCOMES),
    note: z.string().trim().min(1, 'Add a resolution note — it goes on the case record').max(2000),
    creditAmount: moneyStringSchema.optional(),
    /** Lot D (Q92): REINSTALL goes to the order's own agent unless ops name another. */
    agentId: z.string().trim().min(1).max(64).optional(),
  })
  .refine((value) => value.outcome !== 'PARTIAL_CREDIT' || value.creditAmount !== undefined, {
    message: 'A partial credit needs its amount',
    path: ['creditAmount'],
  });

/**
 * E6: `GET /disputes` on the list contract — `?q=&status=a,b&page=&pageSize=`
 * → `{ items, total, page, pageSize, counts }`. The old `?limit=&offset=`
 * pair is still accepted for one release and answers the old bare array;
 * when both are sent the new pair wins. `status` takes one value or a comma
 * list either way.
 */
export const queueQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(DISPUTE_STATUSES)).optional()),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type QueueQuery = z.infer<typeof queueQuerySchema>;

/** Which shape the caller asked for: legacy only when limit/offset came without page/pageSize. */
export function queueShape(query: QueueQuery): { legacy: true; limit: number; offset: number } | { legacy: false; page: number; pageSize: number } {
  const legacy = query.page === undefined && query.pageSize === undefined && (query.limit !== undefined || query.offset !== undefined);
  if (legacy) return { legacy: true, limit: query.limit ?? 50, offset: query.offset ?? 0 };
  return { legacy: false, page: query.page ?? 1, pageSize: query.pageSize ?? DEFAULT_LIST_PAGE_SIZE };
}
