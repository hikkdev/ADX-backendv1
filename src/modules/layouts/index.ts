/**
 * Layouts — LM-1 (27 Sep 2026): what each screen draws.
 *
 * Thirteen surfaces (nine website pages, four app homes), each an ordered
 * list of blocks — the client's own sections and ADX's content blocks —
 * versioned draft → published with history and restore, resolved per caller
 * at `GET /app/layouts/:surface`.
 *
 * PB-1 (27 Sep 2026): the same desk and the same resolution serve a custom
 * Studio page (`site-pages`), keyed `{ pageId }` instead of a surface; the
 * page blocks (hero, columns, form, …), a version's SEO `meta`, preview
 * tokens, and the port `forms` registers so a form block resolves.
 */
export { layoutRouter, appLayoutRouter } from './layouts.routes';
export {
  blockTypes,
  defaultBlocks,
  validateBlocks,
  pageMetaSchema,
  isVideoUrl,
  LAYOUT_SURFACES,
  WEB_SURFACES,
  SURFACE_LABEL,
  SIDES,
  CONTENT_TYPES,
  TARGET_KINDS,
} from './block-registry';
export type { Block, BlockIssue, BlockScope, BlockTypeView, FieldSpec, FieldInput, PageMeta, Side, Target } from './block-registry';
export {
  saveDraft,
  discardDraft,
  publishDraft,
  restoreVersion,
  listVersions,
  getVersions,
  blocksForPreview,
  draftOrLive,
  blocksOf,
  metaOf,
  keyOf,
  cachePrefixOf,
} from './layouts.service';
export type { DraftInput, LayoutVersionView, PreviewSource, VersionKey, VersionRef } from './layouts.service';
export { placeQuerySchema, resolveQuerySchema, previewQuerySchema, saveDraftSchema, publishSchema } from './layouts.schema';
export {
  registerFormResolver,
  resolveForm,
  resetFormResolverForTests,
  resolveBlocks,
  resolveMeta,
  resolveCacheKey,
  placeFor,
  sideFor,
  shuffleAds,
} from './resolve.service';
export type { FormResolver, ResolvedForm, ResolveContext, ResolvedBlock, ResolvedLayout, ResolvedMeta } from './resolve.service';
export { cached as layoutCached, forgetSurface as forgetLayoutPrefix, clearLayoutCache } from './resolve.cache';
export { signPreviewToken, verifyPreviewToken, PREVIEW_TOKEN_TTL_SECONDS } from './preview-token';
export type { PreviewClaim } from './preview-token';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
