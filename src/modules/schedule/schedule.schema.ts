import { z } from 'zod';

/** `YYYY-MM-DD`, and a real day. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Not a calendar day');

/** `HH:mm`, 24-hour. */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

export const SCHEDULE_STATUSES = ['PENDING', 'IN_PROGRESS', 'PAUSED', 'COMPLETED'] as const;
export type ScheduleStatusValue = (typeof SCHEDULE_STATUSES)[number];

/** The three overlays the grid can ask for, as `?include=visits,milestones,jobs`. */
export const OVERLAY_KINDS = ['visits', 'milestones', 'jobs'] as const;
export type OverlayInclude = Record<(typeof OVERLAY_KINDS)[number], boolean>;

/** The widest window one read may ask for: a quarter, in days. */
export const MAX_WINDOW_DAYS = 93;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);

const windowFields = {
  from: isoDateSchema,
  to: isoDateSchema,
};

const windowRefine = <T extends { from: string; to: string }>(schema: z.ZodType<T>) =>
  schema
    .refine((q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] })
    .refine((q) => daysBetween(q.from, q.to) < MAX_WINDOW_DAYS, { message: `The window is wider than ${MAX_WINDOW_DAYS} days`, path: ['to'] });

export const scheduleQuerySchema = windowRefine(
  z.object({
    ...windowFields,
    assigneeUserId: z.string().trim().min(1).max(64).optional(),
    include: z
      .string()
      .optional()
      .transform((value) => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : []))
      .pipe(z.array(z.enum(OVERLAY_KINDS)))
      .transform(
        (kinds): OverlayInclude => ({
          visits: kinds.includes('visits'),
          milestones: kinds.includes('milestones'),
          jobs: kinds.includes('jobs'),
        }),
      ),
  }),
);
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;

export const scheduleLogQuerySchema = windowRefine(
  z.object({
    ...windowFields,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
);
export type ScheduleLogQuery = z.infer<typeof scheduleLogQuerySchema>;

const endAfterStart = (body: { startTime?: string | undefined; endTime?: string | null | undefined }) =>
  !body.startTime || !body.endTime || body.endTime > body.startTime;

export const createEntrySchema = z
  .object({
    date: isoDateSchema,
    startTime: clockTimeSchema,
    endTime: clockTimeSchema.optional(),
    title: z.string().trim().min(1).max(160),
    notes: z.string().trim().max(2000).optional(),
    assigneeUserId: z.string().trim().min(1).max(64),
    department: z.string().trim().min(1).max(120).optional(),
  })
  .refine(endAfterStart, { message: 'The end is not after the start', path: ['endTime'] });
export type CreateEntryInput = z.infer<typeof createEntrySchema>;

export const patchEntrySchema = z
  .object({
    date: isoDateSchema.optional(),
    startTime: clockTimeSchema.optional(),
    endTime: clockTimeSchema.nullable().optional(),
    title: z.string().trim().min(1).max(160).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    assigneeUserId: z.string().trim().min(1).max(64).optional(),
    department: z.string().trim().min(1).max(120).nullable().optional(),
    status: z.enum(SCHEDULE_STATUSES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  // Only when both halves are in the patch; against the stored half, the service checks.
  .refine(endAfterStart, { message: 'The end is not after the start', path: ['endTime'] });
export type PatchEntryInput = z.infer<typeof patchEntrySchema>;
