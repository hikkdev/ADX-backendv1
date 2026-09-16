import { z } from 'zod';
import { upperEnum } from '../../shared/validation';
import { AGENT_REJECTION_REASONS } from '../orders';
import { requirementLabelSchema } from './order-milestones.types';

export const MILESTONE_TYPES = [
  'SURVEY',
  'CREATIVE_COLLECTION',
  'INSTALLATION',
  'VERIFICATION',
  'HEALTH_CHECK',
  'CUSTOM',
] as const;

// `optional` is what the agent app's Mandatory/Optional marker reads. Absent
// means mandatory, so a template written before the flag existed is unchanged.
//
// The label rule is the read path's own (`order-milestones.types`), shared
// rather than restated: a label this accepts but `parseRequirements` drops is a
// requirement the agent is never shown and can never satisfy.
const requirementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('photo'),
    label: requirementLabelSchema,
    optional: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('checklist_item'),
    label: requirementLabelSchema,
    optional: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('qr_scan') }),
  z.object({ kind: z.literal('location_checkin') }),
  z.object({ kind: z.literal('contact_details_visible') }),
]);

export const createTemplateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: upperEnum(MILESTONE_TYPES),
  requirements: z.array(requirementSchema).min(1),
  estimatedDurationMins: z.number().int().positive().optional(),
});

// `type` is absent: a template's type is fixed once created.
export const updateTemplateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  requirements: z.array(requirementSchema).min(1).optional(),
  estimatedDurationMins: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

export const createPlanSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const replacePlanItemsSchema = z.object({
  items: z
    .array(
      z.object({
        templateId: z.string().min(1),
        order: z.number().int().positive(),
        isOptional: z.boolean().optional(),
      }),
    )
    .min(1),
});

export const addMilestoneSchema = z.object({
  templateId: z.string().min(1),
  order: z.number().int().positive().optional(),
  isOptional: z.boolean().optional(),
  dueDate: z.string().datetime().optional(),
  notes: z.string().optional(),
});

// SKIPPED is the only status a client may set; every other transition is
// driven by the agent execution endpoints.
export const updateMilestoneSchema = z.object({
  assignedAgentId: z.string().min(1).optional(),
  order: z.number().int().positive().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  notes: z.string().optional(),
  status: z.literal('SKIPPED').optional(),
});

/* A12: the answers to a visit offer — the order lane's five reasons, and a band. */
export const rejectMilestoneSchema = z
  .object({
    reason: upperEnum(AGENT_REJECTION_REASONS),
    note: z.string().trim().max(300).optional(),
  })
  .refine((body) => body.reason !== 'OTHER' || Boolean(body.note && body.note.length > 0), {
    message: 'Say what the reason is',
    path: ['note'],
  });

export const scheduleMilestoneSchema = z.object({ start: z.string().datetime() });

export const completeMilestoneSchema = z.object({
  evidence: z
    .array(
      z.object({
        kind: z.enum(['photo', 'checklist_item', 'qr_scan', 'location_checkin']),
        label: z.string().max(200).optional(),
        value: z.string().min(1).max(2000),
      }),
    )
    .min(0),
});

/**
 * G12-B: the position ping on a milestone visit — the order lane's body
 * (`orders.schema#locationSchema`: `{ latitude, longitude }`, numbers), so
 * the agent app sends one shape to `/orders/:id/update-location` and here.
 * Restated rather than imported so this module's schema stays free of
 * `orders`' runtime.
 */
export const milestoneLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});
export type MilestoneLocationInput = z.infer<typeof milestoneLocationSchema>;
