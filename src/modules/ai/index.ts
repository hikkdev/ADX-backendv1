/**
 * AI assistance — drafting listing descriptions, and translating the
 * marketplace on the way out.
 *
 * The provider abstraction is in `shared/ai`, not here: `shared/listings` will
 * want translation too, and shared infrastructure may not import a business
 * module. This module owns the rules around it — who may ask, how often, and
 * what must be true of the field first.
 */
export { aiRouter } from './ai.routes';

/**
 * E7-2: the landing-page draft's quota and its row — `campaigns` asks before
 * the model is called and records after it answers, the way the listing
 * draft does. This module imports no other, so the edge is one-way.
 */
export { assertLandingPageQuota, landingPageQuota, recordLandingPageGeneration } from './ai.service';
export type { LandingPageQuota } from './ai.service';

/** Used by the listing read path to translate what it is about to return. */
export { translateBatch, readerLanguage } from './ai.service';
export { translateListings } from './listing-translation';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
