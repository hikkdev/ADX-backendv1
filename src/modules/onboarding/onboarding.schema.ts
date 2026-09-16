import { z } from 'zod';

/**
 * Lot D (Q131): AGENT and EMPLOYEE join the three. The intake form is the
 * onboarding record for both — the direct create screens stay — and an
 * APPROVED submission provisions the profile (`agents.createAgent`) or the
 * HR row (`employees.createEmployee`).
 */
export const userTypeSchema = z.enum(['PUBLISHER', 'ADVERTISER', 'PARTNER', 'AGENT', 'EMPLOYEE']);

/** What an approved AGENT intake hands to `agents.createAgent`; mobile and name fall back to the linked user. */
export const agentIntakeSchema = z.object({
  mobile: z.string().trim().min(10).max(16),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().optional(),
  side: z.enum(['PUBLISHER', 'ADVERTISER']),
  city: z.string().trim().min(1).max(80).optional(),
  state: z.string().trim().min(1).max(80).optional(),
});

/** What an approved EMPLOYEE intake hands to `employees.createEmployee`; everything else in `data` is left where it is. */
export const employeeIntakeSchema = z
  .object({
    department: z.string().optional(),
    designation: z.string().optional(),
    inviteToConsole: z
      .object({
        roleConfigId: z.string().min(1).optional(),
        method: z.enum(['PASSWORD', 'GOOGLE']).default('PASSWORD'),
      })
      .optional(),
  })
  .catchall(z.unknown());

export const submissionStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

export const flowTemplateSchema = z.object({
  userType: userTypeSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().positive().optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1),
  schema: z.record(z.string(), z.unknown()),
  isActive: z.boolean().optional(),
});

export const submissionSchema = z.object({
  flowTemplateId: z.string().min(1).optional(),
  flowTemplateKey: z.string().min(1).optional(),
  userType: userTypeSchema,
  accountType: z.string().min(1).optional(),
  status: submissionStatusSchema.optional(),
  data: z.record(z.string(), z.unknown()),
  // Either link an existing user by id, or provision a new one inline.
  userId: z.string().min(1).optional(),
  user: z
    .object({
      mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number'),
      name: z.string().min(1).optional(),
      email: z.string().email().optional(),
      roles: z.array(z.enum(['PUBLISHER', 'ADVERTISER', 'PARTNER', 'AGENT_PUBLISHER', 'AGENT_ADVERTISER'])).optional(),
    })
    .optional(),
});

export const submissionUpdateSchema = z.object({
  userType: userTypeSchema.optional(),
  accountType: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const statusUpdateSchema = z.object({
  status: submissionStatusSchema,
  rejectionReason: z.string().optional(),
});

/**
 * E7-3: `GET /submissions` on the list contract. `status` is one value or a
 * comma list, upper-cased; `q` is a contains over the intake's name / mobile;
 * `page` / `pageSize` switch the answer from the bare array (kept one
 * release) to `{ items, total, page, pageSize, counts }`.
 */
export const listSubmissionsQuerySchema = z.object({
  userType: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(userTypeSchema)
    .optional(),
  status: z
    .string()
    .trim()
    .transform((value) => value.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(submissionStatusSchema).min(1))
    .optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;
