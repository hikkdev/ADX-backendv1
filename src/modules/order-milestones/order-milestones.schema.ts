import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const MILESTONE_TYPES = [
  'SURVEY',
  'CREATIVE_COLLECTION',
  'INSTALLATION',
  'VERIFICATION',
  'HEALTH_CHECK',
  'CUSTOM',
] as const;

const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), label: z.string().min(1) }),
  z.object({ kind: z.literal('checklist_item'), label: z.string().min(1) }),
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
