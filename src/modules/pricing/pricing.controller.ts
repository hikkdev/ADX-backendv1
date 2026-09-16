import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { prismaPricingRepository as repository } from './prisma-pricing.repository';
import {
  comparablesFor,
  evaluateListing,
  evaluatePrice,
  factorProposals,
  getSettings,
  importMarketData,
  matchMediaType,
  mergeMediaTypes,
  redactComparables,
  refreshSuggestions,
  listAllCities,
  resolveCity,
  revokeImport,
  setFactorApplied,
  slugify,
  suggestedRate,
  updateCity,
} from './pricing.service';
import {
  applyFactorSchema,
  comparablesSchema,
  createFactorSchema,
  createMaterialSchema,
  createMediaTypeSchema,
  createSizeClassSchema,
  createVenueTypeSchema,
  mediaTypeAttributesSchema,
  evaluateSchema,
  importMarketDataSchema,
  matchMediaTypeSchema,
  mergeMediaTypesSchema,
  resolveProposalSchema,
  scraperSourceSchema,
  setScraperEnabledSchema,
  setSurgeEnabledSchema,
  surgeWindowSchema,
  updateMaterialSchema,
  updateScraperSourceSchema,
  updateSizeClassSchema,
  updateVenueTypeSchema,
  updateFactorSchema,
  updateMediaTypeSchema,
  updateCitySchema,
  updateSettingsSchema,
} from './pricing.schema';

const ok = (res: Response, data: unknown): void => {
  res.json({ success: true, data });
};

/** `req.params` is typed `string | string[]`; every id here must be the former. */
function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Missing ${key}`);
  }
  return value;
}

/**
 * Turns a missing row into a 404.
 *
 * Without it a bad id reaches `prisma.*.update`, which throws P2025 — not an
 * ApiError, so the error handler renders it as a 500. A wrong id in a URL is
 * the caller's mistake, not the server's.
 */
async function requireFound<T>(lookup: Promise<T | null>, message: string): Promise<T> {
  const found = await lookup;
  if (!found) throw new ApiError(404, 'NOT_FOUND', message);
  return found;
}

function actor(req: Request): string {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
  return sub;
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success || parsed.data === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error?.flatten());
  }
  return parsed.data;
}

/* ── Evaluation ─────────────────────────────────────────────────────── */

/**
 * Grid a non-ADMIN caller's probe point is snapped to, in decimal degrees.
 *
 * 1e-4 is about 11 m. Both public endpoints answer questions about a point the
 * caller chooses, and `contributorCount` steps down at exactly the radius from
 * each comparable — so a caller who can move the point freely can binary-search
 * that boundary and trilaterate a competitor's spot to within metres. Snapping
 * makes the boundary unsearchable below the grid: the best an attacker can do
 * is locate to a cell.
 *
 * 11 m rather than something coarser because the honest use of this endpoint is
 * a publisher pricing their own spot, and 11 m against a 200 m radius changes
 * essentially nothing about which comparables they see.
 *
 * This raises the cost; it does not remove the exposure. Snapping is the second
 * half of a pair: `marketProbeLimiter` on the routes caps how many probes a
 * caller gets, and the grid caps what each one is worth.
 */
const PROBE_GRID = 1e-4;

const snap = (value: number): number => Math.round(value / PROBE_GRID) * PROBE_GRID;

function probePoint<T extends { latitude: number; longitude: number }>(
  input: T,
  req: Request
): T {
  if ((req.user?.roles ?? []).includes('ADMIN')) return input;
  return { ...input, latitude: snap(input.latitude), longitude: snap(input.longitude) };
}

/**
 * The sentence under the pricing field.
 *
 * Open to any signed-in caller. It returns an aggregate — a range, a count, a
 * verdict — and never the rows behind it, so a caller learns what the market
 * looks like where they are without learning who makes it up.
 */
export async function evaluateHandler(req: Request, res: Response): Promise<void> {
  ok(res, await evaluatePrice(probePoint(parse(evaluateSchema, req.body), req)));
}

/**
 * The working behind the verdict, for the publisher looking at their own form.
 *
 * Redacted: distances rounded, rates and staleness kept, identities and
 * coordinates dropped. See `redactComparables` for why.
 */
export async function publicComparablesHandler(req: Request, res: Response): Promise<void> {
  const set = await comparablesFor(probePoint(parse(comparablesSchema, req.body), req));
  ok(res, redactComparables(set));
}

/** The full set, competitor names and coordinates included. Ops only. */
export async function comparablesHandler(req: Request, res: Response): Promise<void> {
  ok(res, await comparablesFor(parse(comparablesSchema, req.body)));
}

export async function evaluateListingHandler(req: Request, res: Response): Promise<void> {
  ok(res, await evaluateListing(param(req, 'id')));
}

export async function suggestedRateHandler(req: Request, res: Response): Promise<void> {
  ok(res, await suggestedRate(param(req, 'id')));
}

/* ── Vocabularies ───────────────────────────────────────────────────── */

/**
 * The catalogue, at the caller's access level.
 *
 * Reference data every app needs — a publisher picking a spot type, an
 * advertiser reading one back — so it stays open to any signed-in caller. But
 * the *ops* view of it is a different thing: merged tombstones and retired rows
 * are the taxonomy's working papers, and a publisher app that renders them
 * offers a spot type nothing can be filed under. `includeMerged` is honoured
 * for ADMIN and ignored for everyone else, rather than 403'd, so an app that
 * sends it gets the right list instead of an error.
 */
function opsView(req: Request): boolean {
  return (req.user?.roles ?? []).includes('ADMIN');
}

export async function listMediaTypesHandler(req: Request, res: Response): Promise<void> {
  const includeMerged = opsView(req) && req.query['includeMerged'] === 'true';
  ok(res, await repository.listMediaTypes(includeMerged));
}

export async function createMediaTypeHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createMediaTypeSchema, req.body);
  const slug = body.slug ?? slugify(body.name);
  if (await repository.findMediaTypeBySlug(slug)) {
    throw new ApiError(409, 'CONFLICT', `A media type with the slug "${slug}" already exists`);
  }
  // Ids are checked before the write: a bad one would otherwise reach the join
  // table as a foreign-key violation and surface as a 500.
  await assertVocabularyIds(body.sizeClassIds, body.materialIds);
  await assertVenueTypeId(body.venueTypeId);
  ok(res, await repository.createMediaType({ ...body, slug, origin: 'OPS' }));
}

export async function setMediaTypeAttributesHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  await requireFound(repository.findMediaType(id), 'Media type not found');
  const body = parse(mediaTypeAttributesSchema, req.body);
  await assertVocabularyIds(body.sizeClassIds, body.materialIds);
  ok(res, await repository.setMediaTypeAttributes(id, body));
}

/** Rejects unknown ids with a sentence rather than letting an FK 500. */
async function assertVocabularyIds(
  sizeClassIds: string[] | undefined,
  materialIds: string[] | undefined
): Promise<void> {
  if (sizeClassIds?.length) {
    const known = new Set((await repository.listSizeClasses(true)).map((row) => row.id));
    const missing = sizeClassIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ApiError(400, 'BAD_REQUEST', `Unknown size class: ${missing.join(', ')}`);
    }
  }
  if (materialIds?.length) {
    const known = new Set((await repository.listMaterials(true)).map((row) => row.id));
    const missing = materialIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ApiError(400, 'BAD_REQUEST', `Unknown material: ${missing.join(', ')}`);
    }
  }
}

export async function updateMediaTypeHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  await requireFound(repository.findMediaType(id), 'Media type not found');
  const body = parse(updateMediaTypeSchema, req.body);
  await assertVenueTypeId(body.venueTypeId);
  ok(res, await repository.updateMediaType(id, body));
}

/**
 * A venue id that exists, or a sentence saying it does not.
 *
 * Unchecked it reaches Prisma as a foreign-key violation, which the error
 * handler renders as a 500 — the caller's typo presented as the server's fault.
 * `null` is a legitimate value here and passes: an outdoor format has no venue.
 */
async function assertVenueTypeId(venueTypeId: string | null | undefined): Promise<void> {
  if (!venueTypeId) return;
  await requireFound(repository.findVenueType(venueTypeId), 'Venue type not found');
}

export async function matchMediaTypeHandler(req: Request, res: Response): Promise<void> {
  ok(res, await matchMediaType(parse(matchMediaTypeSchema, req.body)));
}

export async function mergeMediaTypesHandler(req: Request, res: Response): Promise<void> {
  const { sourceId, targetId } = parse(mergeMediaTypesSchema, req.body);
  ok(res, await mergeMediaTypes(sourceId, targetId));
}

export async function listMatchLogsHandler(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Number(req.query['limit'] ?? 100) || 100, 500);
  ok(res, await repository.listMediaTypeMatchLogs(limit));
}

export async function listSizeClassesHandler(req: Request, res: Response): Promise<void> {
  const includeInactive = opsView(req) && req.query['includeInactive'] === 'true';
  ok(res, await repository.listSizeClasses(includeInactive));
}

export async function createSizeClassHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createSizeClassSchema, req.body);
  const slug = body.slug ?? slugify(body.name);
  if (await repository.findSizeClassBySlug(slug)) {
    throw new ApiError(409, 'CONFLICT', `A size class with the slug "${slug}" already exists`);
  }
  ok(
    res,
    await repository.createSizeClass({
      name: body.name,
      slug,
      widthFt: body.widthFt ?? null,
      heightFt: body.heightFt ?? null,
    })
  );
}

export async function updateSizeClassHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  await requireFound(repository.findSizeClass(id), 'Size class not found');
  ok(res, await repository.updateSizeClass(id, parse(updateSizeClassSchema, req.body)));
}

/* ── Venues ─────────────────────────────────────────────────────────
 * Open to any signed-in caller on read, because step 2 of the listing wizard
 * is a publisher choosing from this list. Writes are ops: adding a venue
 * splits every pool underneath it.
 */

export async function listVenueTypesHandler(req: Request, res: Response): Promise<void> {
  const includeInactive = opsView(req) && req.query['includeInactive'] === 'true';
  ok(res, await repository.listVenueTypes(includeInactive));
}

export async function createVenueTypeHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createVenueTypeSchema, req.body);
  const slug = body.slug ?? slugify(body.name);
  // Retired rows included: the column is unique whatever `isActive` says, and
  // asking the active-only question here turned re-adding a retired venue into
  // a constraint violation rendered as a 500.
  const clash = await repository.findVenueTypeBySlug(slug, true);
  if (clash) {
    throw new ApiError(
      409,
      'CONFLICT',
      clash.isActive
        ? `A venue type with the slug "${slug}" already exists`
        : `A retired venue type still holds the slug "${slug}" — restore it instead of adding a second`
    );
  }
  ok(
    res,
    await repository.createVenueType({
      name: body.name,
      slug,
      category: body.category,
      description: body.description ?? null,
      subVenues: body.subVenues ?? [],
    })
  );
}

export async function updateVenueTypeHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  await requireFound(repository.findVenueType(id), 'Venue type not found');
  ok(res, await repository.updateVenueType(id, parse(updateVenueTypeSchema, req.body)));
}

export async function listMaterialsHandler(req: Request, res: Response): Promise<void> {
  const includeInactive = opsView(req) && req.query['includeInactive'] === 'true';
  ok(res, await repository.listMaterials(includeInactive));
}

export async function createMaterialHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createMaterialSchema, req.body);
  const slug = body.slug ?? slugify(body.name);
  if (await repository.findMaterialBySlug(slug)) {
    throw new ApiError(409, 'CONFLICT', `A material with the slug "${slug}" already exists`);
  }
  ok(res, await repository.createMaterial({ name: body.name, slug }));
}

export async function updateMaterialHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  await requireFound(repository.findMaterial(id), 'Material not found');
  ok(res, await repository.updateMaterial(id, parse(updateMaterialSchema, req.body)));
}

/* ── Scraper sources ────────────────────────────────────────────────── */

export async function listScraperSourcesHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await repository.listScraperSources());
}

export async function createScraperSourceHandler(req: Request, res: Response): Promise<void> {
  const body = parse(scraperSourceSchema, req.body);
  ok(res, await repository.createScraperSource({ ...body, fieldMap: body.fieldMap ?? null }));
}

export async function updateScraperSourceHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  await requireFound(repository.findScraperSource(id), 'Scraper source not found');
  ok(res, await repository.updateScraperSource(id, parse(updateScraperSourceSchema, req.body)));
}

/** The kill switch for a whole source, not just one window it produced. */
export async function setScraperEnabledHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const { enabled, note } = parse(setScraperEnabledSchema, req.body);
  await requireFound(repository.findScraperSource(id), 'Scraper source not found');
  ok(res, await repository.setScraperSourceEnabled(id, enabled, actor(req), note ?? null));
}

/** Run history — how a source that quietly stopped working becomes visible. */
export async function listScraperRunsHandler(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Number(req.query['limit'] ?? 50) || 50, 200);
  ok(res, await repository.listScraperRuns(param(req, 'id'), limit));
}

export async function listProposalsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await repository.listVocabularyProposals(req.query['resolved'] === 'true'));
}

export async function resolveProposalHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const { resolvedTo } = parse(resolveProposalSchema, req.body);
  await requireFound(repository.findVocabularyProposal(id), 'Vocabulary proposal not found');
  await repository.resolveVocabularyProposal(id, resolvedTo ?? null, actor(req));
  ok(res, { resolved: true });
}

/* ── Factors ────────────────────────────────────────────────────────── */

export async function listFactorsHandler(req: Request, res: Response): Promise<void> {
  const mediaTypeId = req.query['mediaTypeId'];
  ok(res, await repository.listFactors(typeof mediaTypeId === 'string' ? mediaTypeId : undefined));
}

export async function createFactorHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createFactorSchema, req.body);
  ok(
    res,
    await repository.createFactor({
      name: body.name,
      slug: body.slug ?? slugify(body.name),
      description: body.description ?? null,
      kind: body.kind,
      mediaTypeId: body.mediaTypeId,
      multiplier: body.multiplier ?? null,
      baseAdjust: body.baseAdjust ?? null,
      suggestWhen: body.suggestWhen ?? null,
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.bindingDuringSurgeOnly === undefined
        ? {}
        : { bindingDuringSurgeOnly: body.bindingDuringSurgeOnly }),
    })
  );
}

export async function updateFactorHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const factor = await requireFound(repository.findFactor(id), 'Pricing factor not found');
  const patch = parse(updateFactorSchema, req.body);
  // The schema cannot know the factor's kind, so this is the only place the
  // cross-kind patch can be caught. Without it, setting `baseAdjust` on a
  // MULTIPLIER trips the value-matches-kind CHECK and surfaces as a 500.
  const wrongValue =
    factor.kind === 'MULTIPLIER' ? patch.baseAdjust !== undefined : patch.multiplier !== undefined;
  if (wrongValue) {
    throw new ApiError(
      409,
      'CONFLICT',
      `This is a ${factor.kind} factor — set its ${
        factor.kind === 'MULTIPLIER' ? 'multiplier' : 'baseAdjust'
      }, or create a new factor of the other kind`
    );
  }
  ok(res, await repository.updateFactor(id, patch));
}

/**
 * Deletes a factor outright, but only one nothing has been priced with.
 *
 * A factor someone applied to a listing is part of the record of how that price
 * was reached. Deleting it would take the decision with it, so an applied factor
 * is retired instead — the row survives, and nothing new can be priced on it.
 */
export async function deleteFactorHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const factor = await requireFound(repository.findFactor(id), 'Pricing factor not found');
  const applications = await repository.countFactorApplications(id);
  if (applications > 0) {
    throw new ApiError(
      409,
      'CONFLICT',
      `"${factor.name}" is applied to ${applications} listing${applications === 1 ? '' : 's'}. Retire it instead — deleting it would erase how those prices were reached.`
    );
  }
  await repository.deleteFactor(id);
  ok(res, { deleted: true });
}

export async function listingFactorsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await factorProposals(param(req, 'id')));
}

export async function refreshListingFactorsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await refreshSuggestions(param(req, 'id')));
}

export async function applyListingFactorHandler(req: Request, res: Response): Promise<void> {
  const { factorId, applied } = parse(applyFactorSchema, req.body);
  ok(res, await setFactorApplied(param(req, 'id'), factorId, applied, actor(req)));
}

/* ── Market data ────────────────────────────────────────────────────── */

export async function importMarketDataHandler(req: Request, res: Response): Promise<void> {
  const body = parse(importMarketDataSchema, req.body);
  ok(
    res,
    await importMarketData({
      source: body.source,
      filename: body.filename ?? null,
      note: body.note ?? null,
      publisherId: body.publisherId ?? null,
      uploadedById: actor(req),
      rows: body.rows,
    })
  );
}

export async function revokeImportHandler(req: Request, res: Response): Promise<void> {
  ok(res, await revokeImport(param(req, 'id')));
}

/* ── Surge ──────────────────────────────────────────────────────────── */

export async function listSurgeHandler(req: Request, res: Response): Promise<void> {
  ok(
    res,
    await repository.listSurgeWindows({
      includeDisabled: req.query['includeDisabled'] === 'true',
      ...(typeof req.query['from'] === 'string' ? { from: new Date(req.query['from']) } : {}),
      ...(typeof req.query['to'] === 'string' ? { to: new Date(req.query['to']) } : {}),
    })
  );
}

export async function upsertSurgeHandler(req: Request, res: Response): Promise<void> {
  const body = parse(surgeWindowSchema, req.body);
  ok(
    res,
    await repository.upsertSurgeWindow({
      name: body.name,
      scope: body.scope,
      source: body.source,
      externalRef: body.externalRef ?? null,
      city: body.city ?? null,
      // Resolved on write rather than on read: a window has to know which city
      // it means at the moment it is created, and resolving at match time would
      // make every comparison a database read.
      citySlug: await resolveCity(body.city),
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      radiusMeters: body.radiusMeters ?? null,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      upliftPct: body.upliftPct,
      isPublic: body.isPublic,
    })
  );
}

/** The kill switch. A scraper that invents an event has to be stoppable here. */
export async function setSurgeEnabledHandler(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id');
  const { enabled, note } = parse(setSurgeEnabledSchema, req.body);
  await requireFound(repository.findSurgeWindow(id), 'Surge window not found');
  ok(res, await repository.setSurgeEnabled(id, enabled, actor(req), note ?? null));
}

/* ── Settings ───────────────────────────────────────────────────────── */

export async function getSettingsHandler(_req: Request, res: Response): Promise<void> {
  const settings = await getSettings();
  ok(res, {
    ...settings,
    highEdgePct: settings.highEdgePct.toString(),
    lowEdgePct: settings.lowEdgePct.toString(),
    maxCompoundMultiplier: settings.maxCompoundMultiplier.toString(),
    sizeTolerancePct: settings.sizeTolerancePct.toString(),
    maxBindingChangePct: settings.maxBindingChangePct.toString(),
  });
}

export async function updateSettingsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await repository.updateSettings(parse(updateSettingsSchema, req.body), actor(req)));
}

/* ── Cities ─────────────────────────────────────────────────────────
 * Which geographies ADX is open in. Ops-only, and small: the table decides
 * whether a listing or a campaign may name a place at all, so it has to be
 * switchable without a deploy.
 */

export async function listCitiesHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listAllCities());
}

export async function updateCityHandler(req: Request, res: Response): Promise<void> {
  const slug = param(req, 'slug');
  const patch = parse(updateCitySchema, req.body);
  const { before, after } = await updateCity(slug, patch);
  await logActivity(req.user!.sub, 'CITY_UPDATED', {
    req,
    module: 'pricing',
    targetType: 'City',
    targetId: slug,
    diff: auditDiff(before, after, ['isActive', 'aliases']),
  });
  ok(res, after);
}
