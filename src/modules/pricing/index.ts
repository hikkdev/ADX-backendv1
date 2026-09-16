/**
 * Pricing — a price-range suggester, not a quoter.
 *
 * Publishers set their own prices. This tells them whether the number they
 * typed looks right for where they are, by comparing it against spots of the
 * same media type and size class within 200 m. It never blocks a listing.
 *
 * Other modules want `evaluatePrice` (the indicator) or `matchMediaType` (which
 * media type a new spot belongs to). Everything else is ops surface.
 *
 * See docs/pricing-engine.md.
 */
export { pricingRouter } from './pricing.routes';
/** Lot U: the market-data importer's row schema, read by `party-imports`' format guide. */
export { importRowSchema as marketDataImportRowSchema } from './pricing.schema';
export { runDueSources, runSource, isDue } from './scraper/scraper.service';
export {
  comparablesFor,
  evaluateListing,
  evaluatePrice,
  matchMediaType,
  classifySpot,
  checkSpotVocabulary,
  suggestedRate,
  activeSurge,
  surgeWindowsAt,
  buildCityResolver,
  listCities,
  resolveCity,
  strongestSurgeFor,
} from './pricing.service';
/**
 * Lot A (Q31) / Lot V: which geographies ADX is open in, and for what.
 * `listings`, `supply`, `campaigns`, `agents`, `print-partners`, `leads` and
 * the importers call `assertCityAllows(name, function)` before a gated
 * write; a name with no row is allowed, only a catalogued city whose stage
 * has that function switched off refuses (400 `CITY_NOT_OPEN`). `geo` owns
 * the stage machine and the catalogue; this module owns the resolver and
 * the gate because every gated module already imports it.
 */
export { assertCityAllows, citySupport, pickCityRow, slugify } from './pricing.service';
export type { CitySupport, CitySupportView } from './pricing.service';
export { CITY_FUNCTIONS, CITY_STAGES } from './pricing.repository';
export type { CityFunction, CitySwitches, CityStageValue, CityRow } from './pricing.repository';
/**
 * Lot X-B: the city key. Every write that sets a city string stamps the
 * `City` row id beside it through `cityKeyFor` / `withCityKey` (null for a
 * typed town the catalogue lacks — the string stays as typed); every read
 * groups and filters by the key with the spelling as the fallback. An alias
 * edit folds old typed rows in; `backfillCityKeys` re-runs the resolver over
 * every null key (`npm run backfill:city-keys`); `listUnresolvedCities` is
 * what `GET /geo/unresolved` answers.
 */
export { cityKeyFor, withCityKey, buildCityKeyResolver, clearCityKeyCache, listUnresolvedCities, backfillCityKeys } from './pricing.service';
export type { CityKey, CityKeyBackfill, UnresolvedCity } from './pricing.service';
export { CITY_KEYED_TABLES } from './pricing.repository';
export type { CityKeyedTable, UnresolvedCityString } from './pricing.repository';
/**
 * Lot E (Q125): a BINDING factor writes the listing's rate and, above the
 * cap, raises a price case — through this port, registered by bootstrap,
 * because `listings` and `rate-cards` sit above this module.
 */
export { registerListingRepricePort, resetListingRepricePort } from './listing-reprice.port';
export type { ListingRepricePort } from './listing-reprice.port';
export type { SuggestedRate, FactorProposal } from './pricing.service';
export type { PriceIndicator, IndicatorState, ComparableSet } from './pricing.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
