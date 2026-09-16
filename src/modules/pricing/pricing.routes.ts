import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { marketProbeLimiter } from '../../shared/security';
import {
  applyListingFactorHandler,
  comparablesHandler,
  createFactorHandler,
  createMediaTypeHandler,
  evaluateHandler,
  evaluateListingHandler,
  getSettingsHandler,
  importMarketDataHandler,
  listFactorsHandler,
  listMaterialsHandler,
  listMatchLogsHandler,
  listMediaTypesHandler,
  listProposalsHandler,
  listSizeClassesHandler,
  listCitiesHandler,
  listSurgeHandler,
  createMaterialHandler,
  createScraperSourceHandler,
  createSizeClassHandler,
  createVenueTypeHandler,
  deleteFactorHandler,
  setMediaTypeAttributesHandler,
  listScraperRunsHandler,
  listScraperSourcesHandler,
  listingFactorsHandler,
  matchMediaTypeHandler,
  setScraperEnabledHandler,
  updateMaterialHandler,
  updateScraperSourceHandler,
  updateSizeClassHandler,
  updateVenueTypeHandler,
  listVenueTypesHandler,
  publicComparablesHandler,
  mergeMediaTypesHandler,
  refreshListingFactorsHandler,
  resolveProposalHandler,
  revokeImportHandler,
  setSurgeEnabledHandler,
  suggestedRateHandler,
  updateCityHandler,
  updateFactorHandler,
  updateMediaTypeHandler,
  updateSettingsHandler,
  upsertSurgeHandler,
} from './pricing.controller';

export const pricingRouter = Router();
pricingRouter.use(authenticate);

/* ── The indicator ───────────────────────────────────────────────────
 * Any signed-in caller, because a publisher typing a price is the primary
 * user of both. `/evaluate` returns an aggregate; `/comparables/summary`
 * returns the working with identities and coordinates stripped.
 *
 * The unredacted set is ADMIN-only below. Most of what is in it is competitor
 * research that exists nowhere public: open to every signed-in caller, a sweep
 * of arbitrary coordinates would lift the whole dataset a field team was paid
 * to gather. `marketProbeLimiter` bounds the sweep and the controller snaps the
 * probe point to a grid, so neither the volume nor the precision is free.
 */
pricingRouter.post('/evaluate', marketProbeLimiter, asyncHandler(evaluateHandler));
pricingRouter.post(
  '/comparables/summary',
  marketProbeLimiter,
  asyncHandler(publicComparablesHandler)
);
pricingRouter.post('/comparables', requireRole('ADMIN'), asyncHandler(comparablesHandler));

/* ADMIN: exposes the range, tier and surge state for any listing id. */
pricingRouter.get(
  '/listings/:id/indicator',
  requireRole('ADMIN'),
  asyncHandler(evaluateListingHandler)
);

/* Reference data the listing form needs to classify a spot. */
pricingRouter.get('/venue-types', asyncHandler(listVenueTypesHandler));
pricingRouter.get('/media-types', asyncHandler(listMediaTypesHandler));
pricingRouter.get('/size-classes', asyncHandler(listSizeClassesHandler));
pricingRouter.get('/materials', asyncHandler(listMaterialsHandler));

/* ── Taxonomy, ops only ─────────────────────────────────────────────── */
pricingRouter.post('/media-types', requireRole('ADMIN'), asyncHandler(createMediaTypeHandler));
pricingRouter.patch('/media-types/:id', requireRole('ADMIN'), asyncHandler(updateMediaTypeHandler));
/* The sizes and materials a type comes in. Replaces the whole set, so a form
 * that unticks a size can express it. */
pricingRouter.put(
  '/media-types/:id/attributes',
  requireRole('ADMIN'),
  asyncHandler(setMediaTypeAttributesHandler)
);
pricingRouter.post('/media-types/match', requireRole('ADMIN'), asyncHandler(matchMediaTypeHandler));
/* The repair tool for when the similarity threshold gets it wrong. */
pricingRouter.post('/media-types/merge', requireRole('ADMIN'), asyncHandler(mergeMediaTypesHandler));
pricingRouter.get('/media-types/match-log', requireRole('ADMIN'), asyncHandler(listMatchLogsHandler));

/* The controlled lists are only controlled if ops can extend them. Without
 * these, an unrecognised size class or material could be logged as a proposal
 * and then never acted on — a queue with no door out of it. */
pricingRouter.post('/size-classes', requireRole('ADMIN'), asyncHandler(createSizeClassHandler));
pricingRouter.patch('/size-classes/:id', requireRole('ADMIN'), asyncHandler(updateSizeClassHandler));
pricingRouter.post('/materials', requireRole('ADMIN'), asyncHandler(createMaterialHandler));
pricingRouter.patch('/materials/:id', requireRole('ADMIN'), asyncHandler(updateMaterialHandler));
/* Venues sit above media types in the match key, so the same argument applies
 * with more force: without a door in, the taxonomy is whatever the last seed
 * script said it was. */
pricingRouter.post('/venue-types', requireRole('ADMIN'), asyncHandler(createVenueTypeHandler));
pricingRouter.patch('/venue-types/:id', requireRole('ADMIN'), asyncHandler(updateVenueTypeHandler));

pricingRouter.get('/vocabulary/proposals', requireRole('ADMIN'), asyncHandler(listProposalsHandler));
pricingRouter.post(
  '/vocabulary/proposals/:id/resolve',
  requireRole('ADMIN'),
  asyncHandler(resolveProposalHandler)
);

/* ── Factors ────────────────────────────────────────────────────────── */
pricingRouter.get('/factors', requireRole('ADMIN'), asyncHandler(listFactorsHandler));
pricingRouter.post('/factors', requireRole('ADMIN'), asyncHandler(createFactorHandler));
pricingRouter.patch('/factors/:id', requireRole('ADMIN'), asyncHandler(updateFactorHandler));
/* Refuses when the factor has priced anything — see the handler. */
pricingRouter.delete('/factors/:id', requireRole('ADMIN'), asyncHandler(deleteFactorHandler));

pricingRouter.get('/listings/:id/factors', requireRole('ADMIN'), asyncHandler(listingFactorsHandler));
pricingRouter.post(
  '/listings/:id/factors/refresh',
  requireRole('ADMIN'),
  asyncHandler(refreshListingFactorsHandler)
);
/* The engine proposes; this is where a person decides. */
pricingRouter.post(
  '/listings/:id/factors/apply',
  requireRole('ADMIN'),
  asyncHandler(applyListingFactorHandler)
);
/* Base plus applied factors — the offer made to exclusive publishers. */
pricingRouter.get('/listings/:id/suggested-rate', requireRole('ADMIN'), asyncHandler(suggestedRateHandler));

/* ── Market data ────────────────────────────────────────────────────── */
pricingRouter.post('/market-data/import', requireRole('ADMIN'), asyncHandler(importMarketDataHandler));
pricingRouter.post('/market-data/imports/:id/revoke', requireRole('ADMIN'), asyncHandler(revokeImportHandler));

/* ── Surge ──────────────────────────────────────────────────────────── */
pricingRouter.get('/surge', requireRole('ADMIN'), asyncHandler(listSurgeHandler));
pricingRouter.post('/surge', requireRole('ADMIN'), asyncHandler(upsertSurgeHandler));
pricingRouter.post('/surge/:id/enabled', requireRole('ADMIN'), asyncHandler(setSurgeEnabledHandler));

/* ── Scraper sources ─────────────────────────────────────────────────
 * Where the surge calendar comes from. The scraper itself stays headless —
 * what ops needs is the part that changes: which sites are watched, how a
 * page maps onto a window, and the ability to stop a source that has started
 * inventing events without waiting for a deploy.
 */
pricingRouter.get('/scraper-sources', requireRole('ADMIN'), asyncHandler(listScraperSourcesHandler));
pricingRouter.post('/scraper-sources', requireRole('ADMIN'), asyncHandler(createScraperSourceHandler));
pricingRouter.patch(
  '/scraper-sources/:id',
  requireRole('ADMIN'),
  asyncHandler(updateScraperSourceHandler)
);
pricingRouter.post(
  '/scraper-sources/:id/enabled',
  requireRole('ADMIN'),
  asyncHandler(setScraperEnabledHandler)
);
pricingRouter.get(
  '/scraper-sources/:id/runs',
  requireRole('ADMIN'),
  asyncHandler(listScraperRunsHandler)
);

/* ── Cities ─────────────────────────────────────────────────────────
 * The geographies ADX is open in. A listing or a campaign naming a city whose
 * row is switched off is refused (CITY_NOT_SUPPORTED); a name with no row at
 * all is allowed, because the city field is free text and most of India is
 * not in this table.
 */
pricingRouter.get('/cities', requireRole('ADMIN'), asyncHandler(listCitiesHandler));
pricingRouter.patch('/cities/:slug', requireRole('ADMIN'), asyncHandler(updateCityHandler));

/* ── Settings ───────────────────────────────────────────────────────── */
pricingRouter.get('/settings', requireRole('ADMIN'), asyncHandler(getSettingsHandler));
pricingRouter.patch('/settings', requireRole('ADMIN'), asyncHandler(updateSettingsHandler));
