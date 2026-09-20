import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { REPORT_KINDS } from './catalogue';
import { REPORT_RUN_STATUSES, REPORT_SORTS, SCHEDULE_STATUSES } from './reports.repository';
import { WINDOW_PRESETS } from './windows';

export const REPORT_FORMATS = ['CSV', 'PDF'] as const;
export const REPORT_CADENCES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
/** A custom window may not span more than a year — a report, not an export of the database. */
export const MAX_WINDOW_DAYS = 366;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const windowSchema = z.union([
  z.strictObject({ preset: z.enum(WINDOW_PRESETS) }),
  z
    .strictObject({ from: isoDay, to: isoDay })
    .refine((w) => w.from <= w.to, { message: 'from must not be after to' })
    .refine((w) => (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 < MAX_WINDOW_DAYS, { message: `A window spans at most ${MAX_WINDOW_DAYS} days` }),
]);

/** Filters arrive as an object of strings; the kind's own schema (from the catalogue) decides which keys are allowed. */
const rawFiltersInput = z.record(z.string(), z.string().trim().max(120));
const rawFilters = rawFiltersInput.default({});

/** G13-B: a custom `{ from, to }` — the second branch of `windowSchema`, on its own. */
export const fixedWindowSchema = z
  .strictObject({ from: isoDay, to: isoDay })
  .refine((w) => w.from <= w.to, { message: 'from must not be after to' })
  .refine((w) => (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 < MAX_WINDOW_DAYS, { message: `A window spans at most ${MAX_WINDOW_DAYS} days` });

/**
 * G13-B: a schedule's filters may carry `window: { from, to }` beside the
 * kind's own string filters — a fixed date range the job renders instead
 * of the cadence's window. `null` on a PATCH clears it.
 */
const scheduleFiltersInput = z.object({ window: fixedWindowSchema.nullable().optional() }).catchall(z.string().trim().max(120));
export type ScheduleFiltersInput = z.infer<typeof scheduleFiltersInput>;

export const runReportSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  format: z.enum(REPORT_FORMATS).default('CSV'),
  filters: rawFilters,
  window: windowSchema.default({ preset: 'yesterday' }),
});

export const listRunsQuerySchema = listQuerySchema(REPORT_RUN_STATUSES, REPORT_SORTS).extend({
  kind: z.enum(REPORT_KINDS).optional(),
  scheduleId: z.string().trim().min(1).max(64).optional(),
});

export const runIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });
export const fileTokenQuerySchema = z.object({ t: z.string().trim().min(1).max(200).optional() });

const recipients = z.array(z.string().trim().toLowerCase().email()).max(20);

export const createScheduleSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  name: z.string().trim().min(3).max(120),
  cadence: z.enum(REPORT_CADENCES),
  format: z.enum(REPORT_FORMATS).default('CSV'),
  /** Empty means every ADMIN account with an email, resolved when the schedule fires. */
  recipients: recipients.default([]),
  filters: scheduleFiltersInput.default({}),
  enabled: z.boolean().default(true),
});

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    cadence: z.enum(REPORT_CADENCES),
    format: z.enum(REPORT_FORMATS),
    recipients,
    filters: scheduleFiltersInput,
    enabled: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change' });

export const listSchedulesQuerySchema = listQuerySchema(SCHEDULE_STATUSES, REPORT_SORTS).extend({
  kind: z.enum(REPORT_KINDS).optional(),
});

export const scheduleIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });

/** QR-14: the board's window — a preset, or a from/to pair — and its two optional cuts. */
export const onboardingBoardQuerySchema = z
  .object({
    preset: z.enum(WINDOW_PRESETS).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    via: z.enum(['SELF', 'AGENT', 'QR', 'DESK', 'IMPORT']).optional(),
    role: z.string().trim().min(1).max(60).optional(),
  })
  .refine((v) => Boolean(v.preset) || Boolean(v.from && v.to), { message: 'A preset, or from and to' });
