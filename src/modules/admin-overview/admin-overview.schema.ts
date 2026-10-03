import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';
import { BREAKDOWN_DIMENSIONS, BREAKDOWN_SORTS, GRANULARITIES, SEGMENTS } from './analytics.service';

const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');

/**
 * `?month=YYYY-MM`; absent means the month it is now in India. E6:
 * `?from=YYYY-MM&to=YYYY-MM` instead asks for a series — one entry per
 * month, inclusive, at most twenty-four.
 */
export const overviewQuerySchema = z
  .object({
    month: yearMonth.optional(),
    from: yearMonth.optional(),
    to: yearMonth.optional(),
  })
  .refine((query) => (query.from === undefined) === (query.to === undefined), {
    message: 'from and to go together',
    path: ['from'],
  });

/* ── Lot G (Q115): the analytics set ─────────────────────────────────────── */

const isoDay = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');
const listingCategory = z.enum(['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA']);
const city = z.string().trim().min(1).max(80);

/** `?from=&to=&granularity=&segment=&category=&city=` — the series, and the CSV that streams it. */
export const seriesQuerySchema = z.object({
  from: isoDay,
  to: isoDay,
  granularity: z.enum(GRANULARITIES).default('day'),
  segment: z.enum(SEGMENTS).default('ALL'),
  category: listingCategory.optional(),
  city: city.optional(),
});

/** `?from=&to=&by=&q=&sort=&page=&pageSize=` — the list contract over a dimension. */
export const breakdownQuerySchema = z.object({
  from: isoDay,
  to: isoDay,
  by: z.enum(BREAKDOWN_DIMENSIONS),
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(BREAKDOWN_SORTS).default('GMV_DESC'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

export const tilesQuerySchema = z.object({ from: isoDay, to: isoDay });

/* ── AN-1: the registry-backed series ────────────────────────────────── */

/**
 * `?metrics=a,b,c&from=&to=&grain=&category=&city=`.
 *
 * `metrics` is a comma-separated list of registry keys. It is not an enum
 * here on purpose: the registry is the contract, and the service refuses an
 * unknown key with UNKNOWN_METRIC so the message names the metric rather
 * than listing every one that exists.
 */
export const metricsSeriesQuerySchema = z.object({
  from: isoDay,
  to: isoDay,
  grain: z.enum(GRANULARITIES).default('day'),
  metrics: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.split(',').map((key) => key.trim()).filter(Boolean)),
  category: listingCategory.optional(),
  city: city.optional(),
});

/** G13-B: `/insights/:id/dismiss` — the id is a rule key; an unknown one is a 404 downstream, not a 400 here. */
export const insightIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });
