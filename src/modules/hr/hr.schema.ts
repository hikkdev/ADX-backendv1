import { z } from 'zod';

/** `YYYY-MM-DD`, and a real day — `2026-02-30` is refused before it reaches Postgres. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Not a calendar day');

/** A `@db.Date` column is written as the UTC midnight of the day it names. */
export const dateColumn = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);
/** And read back the same way, whatever instant Prisma hands over. */
export const isoDateOf = (value: Date): string => value.toISOString().slice(0, 10);

export const holidaysQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});

/** A region left out or blank is a national day. */
const regionSchema = z
  .string()
  .trim()
  .max(40)
  .optional()
  .transform((value) => (value ? value : null));

/** Lot G (Q123): a gazetted day everyone has off, or a restricted one a person may choose. */
export const HOLIDAY_KINDS = ['PUBLIC', 'OPTIONAL'] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

export const createHolidaySchema = z.object({
  date: isoDateSchema,
  name: z.string().trim().min(1).max(120),
  region: regionSchema,
  kind: z.enum(HOLIDAY_KINDS).default('PUBLIC'),
});

export const patchHolidaySchema = z
  .object({
    date: isoDateSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    region: z.string().trim().max(40).nullable().optional(),
    kind: z.enum(HOLIDAY_KINDS).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const PERSON_KINDS = ['STAFF', 'AGENT'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export const peopleQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(PERSON_KINDS).optional(),
  /** Accepted for the console's sake; the registry only ever lists the active. */
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? true : value === 'true')),
  /** E10-1: list the people who have left too — inactive staff, non-ACTIVE agents — each flagged `active: false`. */
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type HolidaysQuery = z.infer<typeof holidaysQuerySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type PatchHolidayInput = z.infer<typeof patchHolidaySchema>;
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;
