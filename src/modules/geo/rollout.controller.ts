import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { citySupport, listUnresolvedCities } from '../pricing';
import {
  addCitySchema,
  bulkRolloutSchema,
  cityAudienceQuerySchema,
  citySlugParamsSchema,
  listCitiesQuerySchema,
  mapQuerySchema,
  pickerQuerySchema,
  resolveQuerySchema,
  rolloutPatchSchema,
  stateCodeParamsSchema,
  waitlistSchema,
} from './rollout.schema';
import {
  addCity,
  backfillCityKeysLocked,
  bulkRollout,
  changeRollout,
  cityAudienceProfile,
  cityReadiness,
  getCity,
  listCities,
  listDistricts,
  listStates,
  mapPoints,
  pickerCities,
  seedCatalogue,
  summary,
} from './rollout.service';
import { EMPTY_OVERRIDES, geoDatasetSchema, geoOverridesSchema } from './seed.service';
import { joinWaitlist } from './waitlist.service';

/** Where the vendored GeoNames cut lives — the same file `npm run seed:geo` reads. */
export const GEO_DATASET_PATH = path.resolve(__dirname, '../../../data/geo/india-geo.json');
/** W-B: the places the dataset lacks, placed by slug after it (Navi Mumbai). */
export const GEO_OVERRIDES_PATH = path.resolve(__dirname, '../../../data/geo/seed-overrides.json');

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Validation failed', parsed.error.flatten());
  return parsed.data as z.infer<S>;
}

const actor = (req: Request): string => {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
  return sub;
};

const ok = (res: Response, data: unknown): void => {
  res.json({ success: true, data });
};

/* ── reads ─────────────────────────────────────────────────────── */

/** GET /geo/states */
export async function listStatesHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listStates());
}

/** GET /geo/states/:code/districts */
export async function listDistrictsHandler(req: Request, res: Response): Promise<void> {
  const { code } = parse(stateCodeParamsSchema, req.params);
  ok(res, await listDistricts(code));
}

/** GET /geo/cities */
export async function listCitiesHandler(req: Request, res: Response): Promise<void> {
  const query = parse(listCitiesQuerySchema, req.query);
  ok(res, await listCities(query));
}

/** GET /geo/cities/:slug */
export async function getCityHandler(req: Request, res: Response): Promise<void> {
  const { slug } = parse(citySlugParamsSchema, req.params);
  ok(res, await getCity(slug));
}

/** GET /geo/cities/:slug/readiness */
export async function cityReadinessHandler(req: Request, res: Response): Promise<void> {
  const { slug } = parse(citySlugParamsSchema, req.params);
  ok(res, await cityReadiness(slug));
}

/** Y-B: GET /geo/cities/:slug/audience?period= */
export async function cityAudienceHandler(req: Request, res: Response): Promise<void> {
  const { slug } = parse(citySlugParamsSchema, req.params);
  const { period } = parse(cityAudienceQuerySchema, req.query);
  ok(res, await cityAudienceProfile(slug, period));
}

/** GET /geo/map?bbox=&stage= */
export async function mapHandler(req: Request, res: Response): Promise<void> {
  const query = parse(mapQuerySchema, req.query);
  ok(res, await mapPoints(query.bbox ?? null, query.stage ?? null));
}

/** GET /geo/summary */
export async function summaryHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await summary());
}

/**
 * GET /geo/unresolved — Lot X-B: the typed city strings with no key across
 * the eight party tables, with their row counts, so ops can add an alias
 * (`PATCH /pricing/cities/:slug`) or a manual city (`POST /geo/cities`) and
 * fold them in. The console draws it on the Geographies overview.
 */
export async function unresolvedHandler(_req: Request, res: Response): Promise<void> {
  const items = await listUnresolvedCities();
  ok(res, { items, total: items.length, rows: items.reduce((n, item) => n + item.total, 0) });
}

/* ── writes ────────────────────────────────────────────────────── */

/**
 * POST /geo/backfill-city-keys — Lot X-L: the console's button for what
 * `npm run backfill:city-keys` does: re-resolve every null city key across
 * the eight party tables, after a manual city or a fresh seed. Answers
 * `{ tables: [{ table, resolved, stillNull }] }`; 409 while another run
 * holds the lock; audited `GEO_CITY_KEYS_BACKFILLED` with the totals.
 */
export async function backfillCityKeysHandler(req: Request, res: Response): Promise<void> {
  const report = await backfillCityKeysLocked();
  const resolved = report.tables.reduce((n, row) => n + row.resolved, 0);
  const stillNull = report.tables.reduce((n, row) => n + row.stillNull, 0);
  await logActivity(actor(req), 'GEO_CITY_KEYS_BACKFILLED', {
    req,
    module: 'geo',
    targetType: 'City',
    targetId: 'keys',
    metadata: { resolved, stillNull, tables: report.tables },
  });
  ok(res, report);
}

const ROLLOUT_FIELDS = ['stage', 'isActive', 'supplyIntake', 'publishing', 'demand', 'agentOnboarding', 'printPartners', 'leadFeeds', 'launchedAt', 'pausedAt', 'withdrawnAt', 'rolloutNote'] as const;

/** PATCH /geo/cities/:slug/rollout */
export async function rolloutHandler(req: Request, res: Response): Promise<void> {
  const { slug } = parse(citySlugParamsSchema, req.params);
  const { stage, note, ...switches } = parse(rolloutPatchSchema, req.body);
  const outcome = await changeRollout(slug, { stage, switches, note }, actor(req));
  await logActivity(actor(req), 'CITY_ROLLOUT_CHANGED', {
    req,
    module: 'geo',
    targetType: 'City',
    targetId: slug,
    diff: auditDiff(outcome.beforeFlat, outcome.afterFlat, ROLLOUT_FIELDS),
    metadata: { from: outcome.before.stage, to: outcome.after.stage, flipped: outcome.plan.flipped, note: note ?? null },
  });
  ok(res, outcome.after);
}

/** POST /geo/rollout */
export async function bulkRolloutHandler(req: Request, res: Response): Promise<void> {
  const { citySlugs, stateCode, districtId, stage, switches, note } = parse(bulkRolloutSchema, req.body);
  const outcome = await bulkRollout({ citySlugs, stateCode, districtId }, { stage, switches, note }, actor(req));
  await logActivity(actor(req), 'CITY_ROLLOUT_BULK', {
    req,
    module: 'geo',
    targetType: stateCode ? 'GeoState' : districtId ? 'GeoDistrict' : 'City',
    targetId: stateCode ?? districtId ?? `${citySlugs?.length ?? 0} cities`,
    metadata: {
      stage,
      switches: switches ?? null,
      note: note ?? null,
      changed: outcome.changed.length,
      unchanged: outcome.unchanged.length,
      skipped: outcome.skipped.length,
      cities: outcome.changed.map((c) => c.slug),
    },
  });
  ok(res, outcome);
}

/** POST /geo/cities */
export async function addCityHandler(req: Request, res: Response): Promise<void> {
  const body = parse(addCitySchema, req.body);
  const city = await addCity(body);
  await logActivity(actor(req), 'CITY_ADDED', {
    req,
    module: 'geo',
    targetType: 'City',
    targetId: city.slug,
    metadata: { name: city.name, stateCode: body.stateCode, districtCode: body.districtCode ?? null, source: 'MANUAL' },
  });
  res.status(201).json({ success: true, data: city });
}

/** The dataset, read and validated. Shared by the route and `npm run seed:geo`. */
export async function loadGeoDataset(file = GEO_DATASET_PATH) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  const parsed = geoDatasetSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(500, 'INTERNAL_ERROR', `The geography dataset at ${file} does not parse`, parsed.error.flatten());
  return parsed.data;
}

/** W-B: the overrides, read and validated; an absent file is no overrides. Shared by the route and `npm run seed:geo`. */
export async function loadGeoOverrides(file = GEO_OVERRIDES_PATH) {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_OVERRIDES;
    throw err;
  }
  const parsed = geoOverridesSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) throw new ApiError(500, 'INTERNAL_ERROR', `The geography overrides at ${file} do not parse`, parsed.error.flatten());
  return parsed.data;
}

/** POST /geo/seed — the same run as `npm run seed:geo`, from the console. */
export async function seedHandler(req: Request, res: Response): Promise<void> {
  const [dataset, overrides] = await Promise.all([loadGeoDataset(), loadGeoOverrides()]);
  const result = await seedCatalogue(dataset, overrides);
  await logActivity(actor(req), 'GEO_SEEDED', { req, module: 'geo', targetType: 'City', targetId: 'catalogue', metadata: { ...result } });
  ok(res, result);
}

/* ── the app's reads ───────────────────────────────────────────── */

/** GET /app/geo/cities?stage=&q=&lat&lng */
export async function pickerHandler(req: Request, res: Response): Promise<void> {
  const query = parse(pickerQuerySchema, req.query);
  const near = query.lat !== undefined && query.lng !== undefined ? { latitude: query.lat, longitude: query.lng } : null;
  ok(res, await pickerCities({ stages: query.stage, q: query.q, near, limit: query.limit }));
}

/** POST /app/geo/waitlist — W-B: 201 with the lead made, 200 when the phone's lead already stood. Not audited: the requester's own act. */
export async function waitlistHandler(req: Request, res: Response): Promise<void> {
  const body = parse(waitlistSchema, req.body);
  const { created, ...outcome } = await joinWaitlist(body, actor(req));
  res.status(created ? 201 : 200).json({ success: true, data: outcome });
}

/** GET /app/geo/resolve?name= — the stage and switches behind a typed name; an unknown name is allowed and says so. */
export async function resolveHandler(req: Request, res: Response): Promise<void> {
  const { name } = parse(resolveQuerySchema, req.query);
  const view = await citySupport(name);
  ok(res, {
    name,
    resolved: view.resolved,
    slug: view.city?.slug ?? null,
    city: view.city?.name ?? null,
    state: view.city?.state ?? null,
    stage: view.stage,
    switches: view.switches,
    comingSoon: view.resolved && view.stage !== 'LAUNCHED',
  });
}
