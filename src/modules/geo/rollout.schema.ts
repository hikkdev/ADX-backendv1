import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';
import { CITY_STAGES } from '../pricing';
import { CITY_KINDS } from './geo.repository';

/** The wire shapes of the rollout — Lot V. */

const stage = z.enum(CITY_STAGES);
const kind = z.enum(CITY_KINDS);
const slug = z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a slug is lower-case, hyphenated');
const note = z.string().trim().min(1).max(500);
const commaList = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).min(1).optional());

export const switchesSchema = z
  .object({
    supplyIntake: z.boolean(),
    publishing: z.boolean(),
    demand: z.boolean(),
    agentOnboarding: z.boolean(),
    printPartners: z.boolean(),
    leadFeeds: z.boolean(),
  })
  .partial()
  .strict();

/** PATCH /geo/cities/:slug/rollout — the stage, any switch, the note; at least one of them. */
export const rolloutPatchSchema = switchesSchema
  .extend({ stage: stage.optional(), note: note.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Name a stage, a switch or a note' });
export type RolloutPatch = z.infer<typeof rolloutPatchSchema>;

/** POST /geo/rollout — one of the three scopes, the stage, optional switch overrides. */
export const bulkRolloutSchema = z
  .object({
    citySlugs: z.array(slug).min(1).max(500).optional(),
    stateCode: z.string().trim().min(1).max(8).optional(),
    districtId: z.string().trim().min(1).max(64).optional(),
    stage,
    switches: switchesSchema.optional(),
    note: note.optional(),
  })
  .strict()
  .refine((body) => [body.citySlugs, body.stateCode, body.districtId].filter((v) => v !== undefined).length === 1, {
    message: 'Name exactly one of citySlugs, stateCode or districtId',
  });
export type BulkRolloutBody = z.infer<typeof bulkRolloutSchema>;

/** POST /geo/cities — a place the dataset lacks. */
export const addCitySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    stateCode: z.string().trim().min(1).max(8),
    districtCode: z.string().trim().min(1).max(16).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    aliases: z.array(z.string().trim().min(1).max(80)).max(25).optional(),
    population: z.number().int().min(0).optional(),
    kind: kind.optional(),
  })
  .strict();
export type AddCityBody = z.infer<typeof addCitySchema>;

export const citySlugParamsSchema = z.object({ slug });
/** Y-B: GET /geo/cities/:slug/audience?period=YYYY-MM — this month when absent. */
export const cityAudienceQuerySchema = z.object({
  period: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')
    .optional(),
});
export const stateCodeParamsSchema = z.object({ code: z.string().trim().min(1).max(8) });

/** GET /geo/cities — the list contract with the catalogue's own facets. */
export const listCitiesQuerySchema = z.object({
  state: z.string().trim().min(1).max(8).optional(),
  district: z.string().trim().min(1).max(64).optional(),
  stage: commaList(CITY_STAGES),
  q: z.string().trim().min(1).max(120).optional(),
  kind: commaList(CITY_KINDS),
  minPopulation: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['population', 'name']).default('population'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

/** GET /geo/map?bbox=minLng,minLat,maxLng,maxLat&stage= — the pins. */
export const mapQuerySchema = z.object({
  bbox: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'Expected "minLng,minLat,maxLng,maxLat"')
    .transform((value) => {
      const [minLng, minLat, maxLng, maxLat] = value.split(',').map(Number) as [number, number, number, number];
      return { minLat, minLng, maxLat, maxLng };
    })
    .refine((b) => b.minLat <= b.maxLat && b.minLng <= b.maxLng && Math.abs(b.minLat) <= 90 && Math.abs(b.maxLat) <= 90 && Math.abs(b.minLng) <= 180 && Math.abs(b.maxLng) <= 180, 'Out of range')
    .optional(),
  stage: commaList(CITY_STAGES),
});

/** GET /app/geo/cities?stage=&q=&lat&lng — the pickers. */
export const pickerQuerySchema = z
  .object({
    stage: commaList(CITY_STAGES).transform((stages) => stages ?? ['LAUNCHED' as const]),
    q: z.string().trim().min(1).max(120).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), { message: 'lat and lng travel together' });

/** GET /app/geo/resolve?name= */
export const resolveQuerySchema = z.object({ name: z.string().trim().min(1).max(120) });

/** POST /app/geo/waitlist — W-B: "tell me when this city launches", from either side of the market. */
export const WAITLIST_SIDES = ['ADVERTISER', 'PUBLISHER'] as const;
export const waitlistSchema = z
  .object({
    citySlug: slug,
    side: z.enum(WAITLIST_SIDES),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type WaitlistBody = z.infer<typeof waitlistSchema>;
