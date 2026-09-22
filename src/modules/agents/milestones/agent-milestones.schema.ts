import { z } from 'zod';
import { upperEnum } from '../../../shared/validation';
import { MILESTONE_CHIPS } from './milestone.rules';

// LH8: the two lead types — conversions and first contacts inside the window.
export const MILESTONE_TYPES = ['ONBOARDING', 'REVENUE', 'ACTIVITY', 'QUALITY', 'LEAD_CONVERSIONS', 'LEAD_CONTACTS'] as const;

/** A rupee amount on the wire is a decimal string, never a float. */
const amount = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a number with at most two decimal places');

/**
 * Widened from the four fields it had: a template created through the API
 * used to land at `sortOrder 0` and live from the instant it was created —
 * and because the board materialises a row per active template on every
 * read, a bad template permanently polluted every agent's board. Ops can now
 * create one inactive, order it, window it, and switch it on.
 */
export const createMilestoneTemplateSchema = z.object({
  type: upperEnum(MILESTONE_TYPES),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  target: z.number().int().positive(),
  rewardAmount: amount.default('0.00'),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  /** Days the window runs; null counts all time. */
  windowDays: z.number().int().positive().nullable().default(null),
  startsAt: z.string().datetime().nullable().default(null),
  /** How many milestones must be completed before this one opens. */
  unlockAfter: z.number().int().min(0).nullable().default(null),
});
export type CreateMilestoneTemplateInput = z.infer<typeof createMilestoneTemplateSchema>;

export const patchMilestoneTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    target: z.number().int().positive().optional(),
    rewardAmount: amount.optional(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    windowDays: z.number().int().positive().nullable().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    unlockAfter: z.number().int().min(0).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchMilestoneTemplateInput = z.infer<typeof patchMilestoneTemplateSchema>;

/** `?chip=` on the board. ALL is the default and means no filter. */
export const boardQuerySchema = z.object({
  chip: z.enum(MILESTONE_CHIPS).default('ALL'),
});
