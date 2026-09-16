import { z } from 'zod';
import { listQuerySchema } from '../../../shared/pagination';

/**
 * Departments — Lot G (Q122/Q140): the org structure ADX keeps itself.
 *
 * A full record rather than a free string: name and code, an optional head
 * (an Employee), a parent (a tree), the regions it covers, and the number
 * of open roles — a figure ops keep by hand, because hiring stays in the HR
 * tool (Q98). Task assignment and milestone analysis will build on it.
 */

const name = z.string().trim().min(2).max(80);
/** `OPS`, `FIELD-SOUTH`: upper-case, digits and hyphens, so it can print on a badge. */
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/, 'A code is 1–16 upper-case letters, digits or hyphens');
const region = z.string().trim().min(1).max(80);

const createDepartmentBodySchema = z.object({
  name,
  /** Derived from the name when omitted. */
  code: code.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  headId: z.string().trim().min(1).max(64).nullable().optional(),
  /** G11-1: the head by login instead — resolved to the employee record, which is what the row stores. Not beside `headId`. */
  headUserId: z.string().trim().min(1).max(64).nullable().optional(),
  parentId: z.string().trim().min(1).max(64).nullable().optional(),
  regions: z.array(region).max(50).optional(),
  openRoles: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
});

/** G11-1: one way of naming the head per request. */
const oneHead = { message: 'Send headId or headUserId, not both', path: ['headUserId'] as (string | number)[] };
const hasOneHead = (body: { headId?: unknown; headUserId?: unknown }) => body.headId === undefined || body.headUserId === undefined;

export const createDepartmentSchema = createDepartmentBodySchema.refine(hasOneHead, oneHead);

export const patchDepartmentSchema = createDepartmentBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .refine(hasOneHead, oneHead);

export const DEPARTMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const DEPARTMENT_SORTS = ['name', 'newest', 'members'] as const;

/** `?q=&status=ACTIVE|INACTIVE&sort=name|newest|members&page=&pageSize=`. */
export const departmentsQuerySchema = listQuerySchema(DEPARTMENT_STATUSES, DEPARTMENT_SORTS);

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type PatchDepartmentInput = z.infer<typeof patchDepartmentSchema>;
export type DepartmentsQuery = z.infer<typeof departmentsQuerySchema>;

/** `Field operations` → `FIELD-OPERATIONS`; what the create derives when no code is sent. */
export function codeFromName(value: string): string {
  return (
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 16)
      .replace(/-+$/g, '') || 'DEPT'
  );
}
