import { z } from 'zod';

const url = z.string().url().max(500);

export const createModuleSchema = z.object({
  ordinal: z.number().int().min(1),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(500).nullable().default(null),
  durationMins: z.number().int().positive().nullable().default(null),
  videoUrl: url.nullable().default(null),
  lessonBody: z.string().max(20000).nullable().default(null),
  transcript: z.string().max(50000).nullable().default(null),
  takeaways: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  unlockAfterOrdinal: z.number().int().min(1).nullable().default(null),
  passPercent: z.number().int().min(1).max(100).default(80),
  /** Off by default: a module lands on every agent's index the moment it is active. */
  isActive: z.boolean().default(false),
});
export type CreateModuleInput = z.infer<typeof createModuleSchema>;

export const patchModuleSchema = z
  .object({
    ordinal: z.number().int().min(1).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    durationMins: z.number().int().positive().nullable().optional(),
    videoUrl: url.nullable().optional(),
    lessonBody: z.string().max(20000).nullable().optional(),
    transcript: z.string().max(50000).nullable().optional(),
    takeaways: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    unlockAfterOrdinal: z.number().int().min(1).nullable().optional(),
    passPercent: z.number().int().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchModuleInput = z.infer<typeof patchModuleSchema>;

/**
 * PUT /training/modules/:id/questions — the whole set. Every question has
 * exactly one correct option and at least two to choose from; the frame
 * draws four.
 */
export const putQuestionsSchema = z.object({
  questions: z
    .array(
      z
        .object({
          prompt: z.string().trim().min(1).max(500),
          options: z
            .array(z.object({ label: z.string().trim().min(1).max(300), isCorrect: z.boolean().default(false) }))
            .min(2)
            .max(6),
        })
        .refine((q) => q.options.filter((o) => o.isCorrect).length === 1, { message: 'Exactly one option is correct' }),
    )
    .max(50),
});
export type PutQuestionsInput = z.infer<typeof putQuestionsSchema>;

export const progressSchema = z.object({
  percent: z.number().int().min(0).max(99),
  positionSec: z.number().int().min(0).nullable().optional(),
});

export const submitQuizSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1).max(64), optionId: z.string().min(1).max(64) })).max(50),
});

export const revokeCertificationSchema = z.object({ reason: z.string().trim().min(3).max(300) });

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
