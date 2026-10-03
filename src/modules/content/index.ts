/**
 * Content — the pages ADX writes itself (CT-1, 24 Sep 2026).
 *
 * `legal` owns thirteen fixed kinds, each a legal deliverable with its own
 * slot. This owns everything else a page can be: a help article, a guide, a
 * policy outside those thirteen, a page the website needs. Addressed by
 * slug so ops add one without a deploy; versioned exactly as a legal
 * document is; read by both apps and the website without a token.
 */
export { contentRouter } from './content.routes';
export { CATEGORY_META as CONTENT_CATEGORY_META, CONTENT_CATEGORIES, CONTENT_SURFACES, slugify } from './content.types';
/** For a module that wants a published page's text — the website generator reads it over HTTP instead. */
export { currentPage as currentContentPage, publicIndex as contentIndex } from './content.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
