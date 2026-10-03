/**
 * Media — LM-1 (27 Sep 2026): the picture library.
 *
 * Every image a layout block, a tile or a paid placement draws, stored once
 * through the uploads door (purpose MEDIA) and described here — size, spec,
 * alt text. `layouts` reads it to resolve a block's `mediaId`; `promotions`
 * stores a buyer's ad artwork into it through `storeMediaFile`.
 */
export { mediaRouter } from './media.routes';
export { storeMediaFile, findMediaByIds, readImageSize, listSpecs as listMediaSpecs } from './media.service';
export type { MediaView, StoreMediaInput } from './media.service';
export { MEDIA_SPECS, MEDIA_SPEC_KEYS, MEDIA_FORMATS, specFor, ratioMatches, checkAgainstSpec, mediaRef, mediaIdsIn } from './media.types';
export type { MediaSpec, MediaSpecKey, MediaRef, MediaUsage } from './media.types';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
