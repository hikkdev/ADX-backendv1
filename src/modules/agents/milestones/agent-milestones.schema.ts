import { z } from 'zod';
import { upperEnum } from '../../../shared/validation';

export const MILESTONE_TYPES = ['ONBOARDING', 'REVENUE', 'ACTIVITY', 'QUALITY'] as const;

export const createMilestoneTemplateSchema = z.object({
  type: upperEnum(MILESTONE_TYPES),
  title: z.string().min(1),
  description: z.string().min(1),
  target: z.number().int().positive(),
  rewardAmount: z.number().optional(),
});

export const createTrainingResourceSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  duration: z.string().optional(),
  subtitle: z.string().optional(),
  topic: z.string().optional(),
  status: z.string().optional(),
  statusVariant: z.string().optional(),
  videoUrl: z.string().url().optional(),
  documentUrl: z.string().url().optional(),
});
