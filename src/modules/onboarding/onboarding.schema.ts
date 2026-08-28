import { z } from 'zod';

export const userTypeSchema = z.enum(['PUBLISHER', 'ADVERTISER', 'PARTNER']);

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
      roles: z.array(z.enum(['PUBLISHER', 'ADVERTISER', 'PARTNER'])).optional(),
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
