import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { autocompleteHandler, directionsHandler, geocodeHandler, placeHandler, reverseHandler } from './geo.controller';
import {
  addCityHandler,
  backfillCityKeysHandler,
  bulkRolloutHandler,
  cityAudienceHandler,
  cityReadinessHandler,
  getCityHandler,
  listCitiesHandler,
  listDistrictsHandler,
  listStatesHandler,
  mapHandler,
  pickerHandler,
  resolveHandler,
  rolloutHandler,
  seedHandler,
  summaryHandler,
  unresolvedHandler,
  waitlistHandler,
} from './rollout.controller';

export const geoRouter = Router();

// Any signed-in user, any role: a publisher placing a spot, an advertiser
// picking a venue, an agent checking an address, ops geocoding an import.
// Not anonymous — every call here spends the platform's quota.
geoRouter.use(authenticate);

geoRouter.get('/geocode', asyncHandler(geocodeHandler));
geoRouter.get('/reverse', asyncHandler(reverseHandler));
geoRouter.get('/autocomplete', asyncHandler(autocompleteHandler));
geoRouter.get('/places/:placeId', asyncHandler(placeHandler));
// Q137: the route line for a job. Cached 15 minutes per rounded pair.
geoRouter.get('/directions', asyncHandler(directionsHandler));

// ── Lot V: the geography catalogue and the rollout ──────────────────
// Reads are the console's (ADMIN); the two writes that move a city need
// `settings.edit`, and refreshing the catalogue from the dataset is a
// `system.roles`-level act — it writes six thousand rows.
const admin = requireRole('ADMIN');
geoRouter.get('/summary', admin, asyncHandler(summaryHandler));
// Lot X-B: the typed city strings with no key, for the Geographies overview.
geoRouter.get('/unresolved', admin, asyncHandler(unresolvedHandler));
// Lot X-L: the console's re-resolve over every null key — `npm run backfill:city-keys` behind a button, one run at a time.
geoRouter.post('/backfill-city-keys', admin, requirePermission('settings.edit'), asyncHandler(backfillCityKeysHandler));
geoRouter.get('/map', admin, asyncHandler(mapHandler));
geoRouter.get('/states', admin, asyncHandler(listStatesHandler));
geoRouter.get('/states/:code/districts', admin, asyncHandler(listDistrictsHandler));
geoRouter.get('/cities', admin, asyncHandler(listCitiesHandler));
geoRouter.post('/cities', admin, requirePermission('settings.edit'), asyncHandler(addCityHandler));
geoRouter.get('/cities/:slug', admin, asyncHandler(getCityHandler));
geoRouter.get('/cities/:slug/readiness', admin, asyncHandler(cityReadinessHandler));
// Y-B: the city audience profile — the blend over the city's spots' snapshots; calls no vendor unless settings.audience.cityProfileSamplePoints > 0.
geoRouter.get('/cities/:slug/audience', admin, asyncHandler(cityAudienceHandler));
geoRouter.patch('/cities/:slug/rollout', admin, requirePermission('settings.edit'), asyncHandler(rolloutHandler));
geoRouter.post('/rollout', admin, requirePermission('settings.edit'), asyncHandler(bulkRolloutHandler));
geoRouter.post('/seed', admin, requirePermission('system.roles'), asyncHandler(seedHandler));

/**
 * Mounted at /app/geo: the pickers and the typed-name lookup, for any
 * signed-in session — a publisher placing a spot, an advertiser choosing a
 * market, an agent checking where ADX is open.
 */
export const appGeoRouter = Router();
appGeoRouter.use(authenticate);
appGeoRouter.get('/cities', asyncHandler(pickerHandler));
appGeoRouter.get('/resolve', asyncHandler(resolveHandler));
// W-B: "tell me when this city launches" — a lead through `leads`, behind settings.geo.comingSoonWaitlist.
appGeoRouter.post('/waitlist', asyncHandler(waitlistHandler));
