/**
 * Identifiers — human-readable party codes such as PUB-1909-2601.
 *
 * Owns the configurable format per party and the atomic daily counter behind
 * it. Other modules call `allocateIdentifier` when they create a party; nothing
 * else should mint one, because the sequence has to come from the counter.
 */
export { identifierRouter } from './identifiers.routes';
export { allocateIdentifier, previewIdentifier, getFormat } from './identifiers.service';
export { backfillPublisherIdentifiers } from './identifiers.backfill';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
