import { z } from 'zod';

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** A form that makes leads names the side the lead is for. */
export const LEAD_SIDES = ['PUBLISHER', 'ADVERTISER'] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const emailSchema = z.string().trim().toLowerCase().max(160).regex(EMAIL, 'Not an email address');

export const DESTINATIONS = ['LEAD', 'SUPPORT', 'INBOX'] as const;
export const AUDIENCES = ['PUBLIC', 'SIGNED_IN'] as const;
export const SUBMISSION_STATUSES = ['NEW', 'READ', 'ARCHIVED'] as const;

/** `POST /forms` — the plumbing; the key is checked by the service so its message names the rule. */
export const createFormSchema = z.object({
  key: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).nullable().optional(),
  destination: z.preprocess(upper, z.enum(DESTINATIONS)).optional(),
  leadSide: z.preprocess(upper, z.enum(LEAD_SIDES)).nullable().optional(),
  audience: z.preprocess(upper, z.enum(AUDIENCES)).optional(),
  notifyEmails: z.array(emailSchema).max(10).optional(),
});

/** `PATCH /forms/:key` — any of the settings but the key. */
export const patchFormSchema = createFormSchema.omit({ key: true }).partial();

/** `PUT /forms/:key/draft` — the definition is checked by `form-schema.ts`, so every problem is named at once. */
export const saveDraftSchema = z.object({
  definition: z.unknown(),
  changeNote: z.string().trim().max(300).nullable().optional(),
});

export const publishSchema = z.object({ changeNote: z.string().trim().max(300).nullable().optional() });

/** `POST /app/forms/:key/submissions`. `captchaToken` is read by the captcha middleware before this. */
export const submitSchema = z.object({
  answers: z.record(z.string(), z.unknown()).default({}),
  consent: z.boolean().default(false),
  source: z.string().trim().max(120).optional(),
  captchaToken: z.string().optional(),
});

const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** `GET /forms/:key/submissions` and the CSV: the same filter, the page only on the list. */
export const submissionsQuerySchema = z.object({
  status: z.preprocess(upper, z.enum(SUBMISSION_STATUSES)).optional(),
  from: day.optional(),
  to: day.optional(),
  cityId: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** `GET /forms/:key/submissions/map?bbox=w,s,e,n`. */
export const bboxQuerySchema = z.object({
  bbox: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const parts = value.split(',').map((part) => Number(part.trim()));
      const [west, south, east, north] = parts;
      if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || west! > east! || south! > north! || south! < -90 || north! > 90 || west! < -180 || east! > 180) {
        ctx.addIssue({ code: 'custom', message: 'bbox is west,south,east,north in degrees' });
        return z.NEVER;
      }
      return { west: west!, south: south!, east: east!, north: north! };
    }),
});

export const submissionStatusSchema = z.object({ status: z.preprocess(upper, z.enum(SUBMISSION_STATUSES)) });

/** The filter half of the submissions query, with the day bounds as instants (the end inclusive of its whole day). */
export function filterOf(query: z.infer<typeof submissionsQuerySchema>) {
  return {
    status: query.status,
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
    cityId: query.cityId,
  };
}
