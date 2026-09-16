/**
 * Geo — the platform's one door to the maps vendor.
 *
 * Address ↔ coordinates, place search and (Q137) directions. The vendor —
 * Google or Mapbox — is the integrations row's choice and lives behind
 * `shared/maps`; nothing in a module calls either directly. `supply`
 * geocodes an imported listing through here, and the apps ask here for the
 * lookups a phone should not spend its own key on. The key is the server key
 * from the integrations seam; the apps carry the browser key (`GET /app/maps`)
 * for tiles.
 */
export { geoRouter, appGeoRouter } from './geo.routes';

/**
 * Lot V (the owner, 15 Sep 2026): the all-India catalogue and the rollout.
 * `City` stays `pricing`'s table (the resolver and the gate live there);
 * this module owns the stage machine, the catalogue's editor, the seed and
 * the wind-down. `jobs/city-winddown.job.ts` runs `runCityWindDown`;
 * `scripts/seedGeo.ts` runs `runGeoSeed` over `loadGeoDataset()`.
 */
export { runGeoSeed, geoDatasetSchema, geoOverridesSchema, cleanPlaceName } from './seed.service';
export type { GeoDataset, GeoOverrides, GeoSeedSummary } from './seed.service';
export { loadGeoDataset, loadGeoOverrides, GEO_DATASET_PATH, GEO_OVERRIDES_PATH } from './rollout.controller';
export { runCityWindDown, windDownCity } from './winddown.service';
/** W-B: the coming-soon waitlist, for tests and anything that joins one server-side. */
export { joinWaitlist, WAITLIST_SETTING_KEY } from './waitlist.service';
export type { WaitlistOutcome } from './waitlist.service';
export type { WindDownSummary } from './winddown.service';
export { STAGE_TRANSITIONS, DEFAULT_SWITCHES, mirrorOf, canMove, planRollout } from './rollout.rules';
export { prismaGeoRepository } from './prisma-geo.repository';
export type { GeoRepository, GeoCityRow, CityKind, CitySource } from './geo.repository';

/** For `supply` and anything else that turns an address into a point. */
export { geocodeAddress, reverseGeocode } from '../../shared/maps';
export type { GeoPoint, GeocodedPlace, PlacePrediction, Directions } from '../../shared/maps';
/** For the agent app's job screens, through their own modules, and for tests. */
export { directionsBetween } from './directions.service';
/** Y-B: the city audience profile — the lead score (the leads lots) reads a city's footfall for fit through it. */
export { cityAudienceProfile } from './rollout.service';
export type { CityAudienceProfile } from './audience-profile.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
