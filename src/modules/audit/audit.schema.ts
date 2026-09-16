import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';
import { ACTIVITY_SORTS } from '../../shared/audit';

const token = z.string().trim().min(1).max(120);
/** ISO date or datetime; a bare date is the start of that day, UTC. */
const instant = z.coerce.date();

export const auditFilterSchema = z
  .object({
    q: token.optional(),
    action: token.optional(),
    module: token.optional(),
    targetType: token.optional(),
    targetId: token.optional(),
    userId: token.optional(),
    from: instant.optional(),
    to: instant.optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: 'from must not be after to', path: ['from'] });

export const auditPageSchema = z.object({
  sort: z.enum(ACTIVITY_SORTS).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

/** `GET /audit` and `GET /audit/export.csv` share the filter; only the page differs. */
export const listAuditQuerySchema = z.intersection(auditFilterSchema, auditPageSchema);
export const exportAuditQuerySchema = z.intersection(auditFilterSchema, auditPageSchema.pick({ sort: true }));

export const targetParamsSchema = z.object({
  targetType: token,
  targetId: token,
});

export type AuditFilterInput = z.infer<typeof auditFilterSchema>;
export type AuditPageInput = z.infer<typeof auditPageSchema>;
