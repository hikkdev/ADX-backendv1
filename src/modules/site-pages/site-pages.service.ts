import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { LayoutSurface, SitePageChannel, SitePageKind } from '../../shared/database';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { currentContentPage } from '../content';
import {
  blocksForPreview,
  blocksOf,
  clearLayoutCache,
  defaultBlocks,
  discardDraft,
  draftOrLive,
  forgetLayoutPrefix,
  getVersions,
  layoutCached,
  listVersions,
  metaOf,
  placeFor,
  publishDraft,
  resolveBlocks,
  resolveCacheKey,
  resolveMeta,
  restoreVersion,
  saveDraft,
  shuffleAds,
  sideFor,
  signPreviewToken,
  verifyPreviewToken,
  type Block,
  type DraftInput,
  type LayoutVersionView,
  type PageMeta,
  type ResolveContext,
  type ResolvedBlock,
  type ResolvedMeta,
  type VersionKey,
} from '../layouts';
import { prismaSitePagesRepository as repository } from './prisma-site-pages.repository';
import type { PageRow, SitePage, SiteRedirect, VersionSummary } from './site-pages.repository';
import { checkRedirectSource, checkRedirectTarget, checkSitePath, hasParam } from './paths';
import { templateBlocks, type PageTemplate } from './templates';

/**
 * PB-1 (27 Sep 2026): the site's pages — what exists, where it lives, and
 * where the old addresses go.
 *
 * Nine SYSTEM pages are the website's own, seeded by migration: each is
 * drawn by a Next route (`internalPath`) and laid out under a layout
 * surface; only its title and address are this module's. A CUSTOM page is
 * Studio's: built from content blocks, versioned by `layouts` under
 * `{ pageId }`, drawn by the website at `/pg/<key>` behind its address and
 * by the apps on the Page screen. The owner: "Only admins can change the
 * addresses." — `content.addresses`, checked at the door; every change of
 * address leaves a permanent redirect behind and re-points any redirect
 * that aimed at the old address, so nothing ever chains.
 *
 * The public reads — the routing table the website's proxy consults, the
 * sitemap, a page resolved — are cached in process for sixty seconds under
 * the `site` and `page:<id>` prefixes of `layouts`' cache, forgotten on
 * every write here and on every publish there.
 */

type Actor = { userId: string; req?: Request | undefined };

const MODULE = 'site-pages';
const SITE_CACHE = 'site';

const forgetSite = () => forgetLayoutPrefix(SITE_CACHE);

/* ── Shapes ────────────────────────────────────────────────────────── */

export type PageSummary = {
  id: string;
  key: string;
  kind: SitePageKind;
  title: string;
  path: string;
  internalPath: string | null;
  surface: LayoutSurface | null;
  channels: SitePageChannel[];
  addressLocked: boolean;
  archivedAt: Date | null;
  live: { number: number; publishedAt: Date | null } | null;
  draft: { number: number; updatedAt: Date } | null;
  updatedAt: Date;
  redirectCount: number;
};

export type PageDetail = Omit<PageSummary, 'live' | 'draft'> & {
  createdAt: Date;
  live: LayoutVersionView | null;
  draft: LayoutVersionView | null;
  versions: LayoutVersionView[];
  defaults: Block[];
};

export type RedirectView = {
  id: string;
  fromPath: string;
  toPath: string;
  permanent: boolean;
  reason: SiteRedirect['reason'];
  page: { key: string; title: string } | null;
  createdAt: Date;
};

export type RoutePage = { key: string; kind: SitePageKind; title: string; path: string; internalPath: string | null; channels: SitePageChannel[] };
export type RouteRedirect = { fromPath: string; toPath: string; permanent: boolean };
export type RoutesTable = { version: string; pages: RoutePage[]; redirects: RouteRedirect[] };
export type SitemapEntry = { path: string; updatedAt: Date };

export type PublicPage = {
  key: string;
  title: string;
  path: string;
  channels: SitePageChannel[];
  version: number;
  isDefault: boolean;
  meta: ResolvedMeta;
  blocks: ResolvedBlock[];
  preview?: true;
};

/* ── Helpers ───────────────────────────────────────────────────────── */

/** Where a page's versions live: a SYSTEM page under its surface, a CUSTOM page under its own id. */
export function versionKeyOf(page: Pick<SitePage, 'id' | 'kind' | 'surface'>): VersionKey {
  if (page.kind === 'SYSTEM') {
    if (!page.surface) throw new ApiError(500, 'INTERNAL_ERROR', `System page ${page.id} names no layout surface`);
    return { surface: page.surface };
  }
  return { pageId: page.id };
}

const belongs = (page: Pick<SitePage, 'id' | 'kind' | 'surface'>, version: Pick<VersionSummary, 'surface' | 'pageId'>): boolean =>
  page.kind === 'SYSTEM' ? version.surface === page.surface : version.pageId === page.id;

const latest = <T extends { number: number }>(rows: T[]): T | undefined => rows.sort((a, b) => b.number - a.number)[0];

function summarise(page: PageRow, versions: VersionSummary[]): PageSummary {
  const mine = versions.filter((version) => belongs(page, version));
  const live = latest(mine.filter((version) => version.status === 'PUBLISHED'));
  const draft = latest(mine.filter((version) => version.status === 'DRAFT'));
  return {
    id: page.id,
    key: page.key,
    kind: page.kind,
    title: page.title,
    path: page.path,
    internalPath: page.internalPath,
    surface: page.surface,
    channels: page.channels,
    addressLocked: page.addressLocked,
    archivedAt: page.archivedAt,
    live: live ? { number: live.number, publishedAt: live.publishedAt } : null,
    draft: draft ? { number: draft.number, updatedAt: draft.updatedAt } : null,
    updatedAt: page.updatedAt,
    redirectCount: page.redirectCount,
  };
}

const KIND_ORDER: Record<SitePageKind, number> = { SYSTEM: 0, CUSTOM: 1 };

/** A page by key, or a 404. */
export async function pageByKey(key: string): Promise<SitePage> {
  const page = await repository.findByKey(key);
  if (!page) throw new ApiError(404, 'NOT_FOUND', `No page "${key}"`);
  return page;
}

function assertCustom(page: SitePage, what: string): void {
  if (page.kind !== 'CUSTOM') throw new ApiError(409, 'CONFLICT', `"${page.key}" is one of the site's own pages — it cannot be ${what}`);
}

function assertNotArchived(page: SitePage): void {
  if (page.archivedAt) throw new ApiError(409, 'CONFLICT', `"${page.key}" is archived — restore it first`);
}

/** The address rules, then the one namespace pages and redirect sources share. */
async function assertAddressFree(path: string, options: { exceptPageId?: string | undefined; allowOwnRedirect?: string | undefined } = {}): Promise<SiteRedirect | null> {
  const taken = await repository.pageAtPath(path);
  if (taken && taken.id !== options.exceptPageId) throw new ApiError(409, 'CONFLICT', `${path} is the address of "${taken.title}" (${taken.key})`);
  const redirect = await repository.redirectFrom(path);
  if (redirect) {
    if (options.allowOwnRedirect && redirect.pageId === options.allowOwnRedirect) return redirect;
    throw new ApiError(409, 'CONFLICT', `${path} already redirects to ${redirect.toPath} — delete that redirect first`);
  }
  return null;
}

const pathIssue = (message: string, path: string) => new ApiError(400, 'VALIDATION_ERROR', message, { field: 'path', path });

/* ── The desk: pages ───────────────────────────────────────────────── */

/** `GET /site/pages` — every page, the site's own first, with what is live and what waits. */
export async function listPages(): Promise<PageSummary[]> {
  const [pages, versions] = await Promise.all([repository.listPages(), repository.currentVersions()]);
  return pages
    .map((page) => summarise(page, versions))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title));
}

/** `GET /site/pages/:key` — the page with its live version, draft, history and (a SYSTEM page's) defaults. */
export async function getPage(key: string): Promise<PageDetail> {
  return detailOf(await pageByKey(key));
}

async function detailOf(page: SitePage): Promise<PageDetail> {
  const versionKey = versionKeyOf(page);
  const [{ live, draft }, versions, rows] = await Promise.all([getVersions(versionKey), listVersions(versionKey), repository.listPages()]);
  const row = rows.find((candidate) => candidate.id === page.id);
  return {
    id: page.id,
    key: page.key,
    kind: page.kind,
    title: page.title,
    path: page.path,
    internalPath: page.internalPath,
    surface: page.surface,
    channels: page.channels,
    addressLocked: page.addressLocked,
    archivedAt: page.archivedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    redirectCount: row?.redirectCount ?? 0,
    live,
    draft,
    versions,
    defaults: page.surface ? defaultBlocks(page.surface) : [],
  };
}

export type CreatePageInput = { key: string; title: string; path: string; channels?: SitePageChannel[] | undefined; template?: PageTemplate | undefined };

/** `POST /site/pages` — a CUSTOM page with its address and a version-1 draft from the template. */
export async function createPage(input: CreatePageInput, actor: Actor): Promise<PageDetail> {
  const existing = await repository.findByKey(input.key);
  if (existing) {
    throw new ApiError(409, 'CONFLICT', existing.kind === 'SYSTEM' ? `"${input.key}" is one of the site's own pages — pick another key` : `A page "${input.key}" exists already`);
  }
  const path = checkSitePath(input.path, { key: input.key, kind: 'CUSTOM' });
  if (!path.ok) throw pathIssue(path.message, input.path);
  await assertAddressFree(path.path);
  const page = await repository.createPage({ key: input.key, title: input.title, path: path.path, channels: input.channels ?? ['WEBSITE'], createdByUserId: actor.userId });
  const template = input.template ?? 'blank';
  await saveDraft({ pageId: page.id }, { blocks: templateBlocks(template, page.title), changeNote: `New page from the ${template} template` }, actor);
  forgetSite();
  await logActivity(actor.userId, 'SITE_PAGE_CREATED', {
    req: actor.req,
    targetType: 'SitePage',
    targetId: page.id,
    module: MODULE,
    metadata: { key: page.key, path: page.path, channels: page.channels, template },
  });
  return detailOf(page);
}

/**
 * `POST /site/pages/from-content/:slug` — PB-6: a published WEBSITE content
 * page becomes a Studio page of the same slug, one text block, published at
 * once. Its text history stays in `content`; the page reads the live text.
 */
export async function createFromContent(slug: string, actor: Actor): Promise<PageDetail> {
  const content = await currentContentPage(slug);
  if (!content.surfaces.includes('WEBSITE')) throw new ApiError(400, 'VALIDATION_ERROR', `"${slug}" is not a website page — add WEBSITE to its surfaces first`);
  const existing = await repository.findByKey(slug);
  if (existing) throw new ApiError(409, 'CONFLICT', `A page "${slug}" exists already`);
  const path = checkSitePath(`/${slug}`, { key: slug, kind: 'CUSTOM' });
  if (!path.ok) throw pathIssue(path.message, `/${slug}`);
  await assertAddressFree(path.path);
  const page = await repository.createPage({ key: slug, title: content.title, path: path.path, channels: ['WEBSITE'], createdByUserId: actor.userId });
  const key: VersionKey = { pageId: page.id };
  const meta: PageMeta = {};
  if (content.seoTitle) meta.seoTitle = content.seoTitle;
  if (content.seoDescription) meta.seoDescription = content.seoDescription;
  await saveDraft(key, { blocks: [{ id: `${slug}-text`, type: 'rich_text', props: { contentSlug: slug } }], meta, changeNote: `From the content page "${slug}"` }, actor);
  await publishDraft(key, {}, actor);
  forgetSite();
  await logActivity(actor.userId, 'SITE_PAGE_CREATED', {
    req: actor.req,
    targetType: 'SitePage',
    targetId: page.id,
    module: MODULE,
    metadata: { key: page.key, path: page.path, channels: page.channels, fromContent: slug },
  });
  return detailOf(page);
}

export type PagePatchInput = { title?: string | undefined; channels?: SitePageChannel[] | undefined; path?: string | undefined };

/**
 * `PATCH /site/pages/:key` — the title and channels with `content.edit`;
 * the address with `content.addresses` (the controller checks the door).
 * An address change writes the redirect and re-points the others.
 */
export async function updatePage(key: string, patch: PagePatchInput, actor: Actor): Promise<PageDetail> {
  const page = await pageByKey(key);
  const fields: { title?: string; channels?: SitePageChannel[] } = {};
  if (patch.title !== undefined && patch.title !== page.title) fields.title = patch.title;
  if (patch.channels !== undefined) {
    if (page.kind === 'SYSTEM' && (patch.channels.length !== 1 || patch.channels[0] !== 'WEBSITE')) {
      throw new ApiError(400, 'VALIDATION_ERROR', "One of the site's own pages is a website page — its channels do not change");
    }
    if ([...patch.channels].sort().join() !== [...page.channels].sort().join()) fields.channels = patch.channels;
  }
  if (Object.keys(fields).length) {
    const before = { title: page.title, channels: page.channels };
    await repository.updatePage(page.id, fields);
    forgetSite();
    await logActivity(actor.userId, 'SITE_PAGE_UPDATED', {
      req: actor.req,
      targetType: 'SitePage',
      targetId: page.id,
      module: MODULE,
      diff: Object.fromEntries(Object.entries(fields).map(([field, after]) => [field, { before: before[field as keyof typeof before], after }])),
      metadata: { key: page.key },
    });
  }
  if (patch.path !== undefined) await changeAddress(page, patch.path, actor);
  return getPage(key);
}

async function changeAddress(page: SitePage, raw: string, actor: Actor): Promise<void> {
  const check = checkSitePath(raw, { key: page.key, kind: page.kind, internalPath: page.internalPath });
  if (!check.ok) throw pathIssue(check.message, raw);
  if (check.path === page.path) return;
  if (page.addressLocked) throw new ApiError(409, 'CONFLICT', `The address of "${page.title}" never changes`);
  const own = await assertAddressFree(check.path, { exceptPageId: page.id, allowOwnRedirect: page.id });
  const { retargeted } = await repository.changeAddress({ pageId: page.id, oldPath: page.path, newPath: check.path, by: actor.userId, dropRedirectId: own?.id ?? null });
  forgetSite();
  // PAGE targets resolve to an href in every surface's cached answer — all of them are stale now.
  clearLayoutCache();
  await logActivity(actor.userId, 'SITE_PAGE_ADDRESS_CHANGED', {
    req: actor.req,
    targetType: 'SitePage',
    targetId: page.id,
    module: MODULE,
    diff: { path: { before: page.path, after: check.path } },
    metadata: { key: page.key, redirectFrom: page.path, retargeted, droppedOwnRedirect: own?.id ?? null },
  });
}

/** `POST /site/pages/:key/archive` — a CUSTOM page leaves the site; its address stays taken and its versions stay. */
export async function archivePage(key: string, actor: Actor): Promise<PageDetail> {
  const page = await pageByKey(key);
  assertCustom(page, 'archived — hide its sections instead');
  if (!page.archivedAt) {
    await repository.updatePage(page.id, { archivedAt: new Date() });
    forgetSite();
    clearLayoutCache();
    await logActivity(actor.userId, 'SITE_PAGE_ARCHIVED', { req: actor.req, targetType: 'SitePage', targetId: page.id, module: MODULE, metadata: { key: page.key, path: page.path } });
  }
  return getPage(key);
}

/** `POST /site/pages/:key/restore-page` — back on the site as it was. */
export async function restorePage(key: string, actor: Actor): Promise<PageDetail> {
  const page = await pageByKey(key);
  if (page.archivedAt) {
    await repository.updatePage(page.id, { archivedAt: null });
    forgetSite();
    clearLayoutCache();
    await logActivity(actor.userId, 'SITE_PAGE_RESTORED', { req: actor.req, targetType: 'SitePage', targetId: page.id, module: MODULE, metadata: { key: page.key, path: page.path } });
  }
  return getPage(key);
}

/* ── The desk: versions (the layouts desk, keyed by the page) ──────── */

export async function savePageDraft(key: string, input: DraftInput, actor: Actor): Promise<LayoutVersionView> {
  const page = await pageByKey(key);
  assertNotArchived(page);
  return saveDraft(versionKeyOf(page), input, actor);
}

export async function discardPageDraft(key: string, actor: Actor): Promise<void> {
  const page = await pageByKey(key);
  await discardDraft(versionKeyOf(page), actor);
}

export async function publishPage(key: string, input: { changeNote?: string | null | undefined }, actor: Actor): Promise<LayoutVersionView> {
  const page = await pageByKey(key);
  assertNotArchived(page);
  const view = await publishDraft(versionKeyOf(page), input, actor);
  // A custom page joins the routing table with its first published version.
  forgetSite();
  return view;
}

export async function pageVersions(key: string): Promise<LayoutVersionView[]> {
  const page = await pageByKey(key);
  return listVersions(versionKeyOf(page));
}

export async function restorePageVersion(key: string, number: number, actor: Actor): Promise<LayoutVersionView> {
  const page = await pageByKey(key);
  assertNotArchived(page);
  const view = await restoreVersion(versionKeyOf(page), number, actor);
  forgetSite();
  return view;
}

export type PlaceQuery = { side?: string | undefined; city?: string | undefined; cityId?: string | undefined; stage?: string | undefined };

async function contextFor(page: SitePage, query: PlaceQuery, roles: readonly string[] | undefined): Promise<ResolveContext> {
  const place = await placeFor(query);
  return { side: sideFor(page.surface, roles, query.side), ...place, now: new Date() };
}

/** `GET /site/pages/:key/preview?version=draft|<n>` — the public shape for a version that may not be live. */
export async function previewPage(key: string, version: 'draft' | number, query: PlaceQuery, roles: readonly string[] | undefined): Promise<PublicPage> {
  const page = await pageByKey(key);
  const source = await blocksForPreview(versionKeyOf(page), version);
  const ctx = await contextFor(page, query, roles);
  const [blocks, meta] = await Promise.all([resolveBlocks(source.blocks, ctx), resolveMeta(source.meta)]);
  return { key: page.key, title: page.title, path: page.path, channels: page.channels, version: source.number, isDefault: source.isDefault, meta, blocks: shuffleAds(blocks) };
}

/** `POST /site/pages/:key/preview-token` — a day's token for `GET /app/pages/:key?preview=` to answer the draft. */
export async function pagePreviewToken(key: string): Promise<{ token: string; expiresAt: Date }> {
  const page = await pageByKey(key);
  return signPreviewToken({ kind: 'page', ref: page.key });
}

/* ── The desk: redirects ───────────────────────────────────────────── */

const redirectView = (row: SiteRedirect & { page?: { key: string; title: string } | null }): RedirectView => ({
  id: row.id,
  fromPath: row.fromPath,
  toPath: row.toPath,
  permanent: row.permanent,
  reason: row.reason,
  page: row.page ?? null,
  createdAt: row.createdAt,
});

export async function listRedirects(): Promise<RedirectView[]> {
  return (await repository.listRedirects()).map(redirectView);
}

export type CreateRedirectInput = { fromPath: string; toPath: string; permanent?: boolean | undefined };

/** `POST /site/redirects` — by hand (`content.addresses`). The destination page is linked when the target is one of ours. */
export async function createRedirect(input: CreateRedirectInput, actor: Actor): Promise<RedirectView> {
  const from = checkRedirectSource(input.fromPath);
  if (!from.ok) throw new ApiError(400, 'VALIDATION_ERROR', from.message, { field: 'fromPath' });
  const to = checkRedirectTarget(input.toPath);
  if (!to.ok) throw new ApiError(400, 'VALIDATION_ERROR', to.message, { field: 'toPath' });
  if (from.path === to.path) throw new ApiError(400, 'VALIDATION_ERROR', 'A redirect goes somewhere else', { field: 'toPath' });
  await assertAddressFree(from.path);
  const target = to.path.startsWith('/') ? await repository.pageAtPath(to.path.split('?')[0]!) : null;
  const row = await repository.createRedirect({
    fromPath: from.path,
    toPath: to.path,
    pageId: target?.id ?? null,
    permanent: input.permanent ?? true,
    reason: 'MANUAL',
    createdByUserId: actor.userId,
  });
  forgetSite();
  await logActivity(actor.userId, 'SITE_REDIRECT_CREATED', {
    req: actor.req,
    targetType: 'SiteRedirect',
    targetId: row.id,
    module: MODULE,
    metadata: { fromPath: row.fromPath, toPath: row.toPath, permanent: row.permanent, pageKey: target?.key ?? null },
  });
  return redirectView({ ...row, page: target ? { key: target.key, title: target.title } : null });
}

export async function deleteRedirect(id: string, actor: Actor): Promise<void> {
  const row = await repository.findRedirect(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such redirect');
  await repository.deleteRedirect(id);
  forgetSite();
  await logActivity(actor.userId, 'SITE_REDIRECT_DELETED', {
    req: actor.req,
    targetType: 'SiteRedirect',
    targetId: row.id,
    module: MODULE,
    metadata: { fromPath: row.fromPath, toPath: row.toPath, reason: row.reason },
  });
}

/* ── Public ────────────────────────────────────────────────────────── */

type LivePages = { pages: PageRow[]; versions: VersionSummary[] };

/** Unarchived pages and every PUBLISHED row — the two reads the public answers share. */
async function livePages(): Promise<LivePages> {
  const [pages, versions] = await Promise.all([repository.listPages(), repository.currentVersions()]);
  return { pages: pages.filter((page) => !page.archivedAt), versions: versions.filter((version) => version.status === 'PUBLISHED') };
}

const liveOf = (page: PageRow, versions: VersionSummary[]): VersionSummary | undefined => latest(versions.filter((version) => belongs(page, version)));

/** Whether a page answers at its address: a SYSTEM page always, a CUSTOM page once something is published. */
const isLive = (page: PageRow, versions: VersionSummary[]): boolean => page.kind === 'SYSTEM' || !!liveOf(page, versions);

/**
 * `GET /app/site/routes` — what the website's proxy and the apps' deep
 * links consult: every live page with its address (and, for the site's
 * own, the route that draws it), and every redirect. `version` changes
 * whenever the table does, so a client can tell a fresh read from a repeat.
 */
export async function routesTable(): Promise<RoutesTable> {
  return layoutCached(`${SITE_CACHE}|routes`, async () => {
    const { pages, versions } = await livePages();
    const live: RoutePage[] = pages
      .filter((page) => isLive(page, versions))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path))
      .map((page) => ({ key: page.key, kind: page.kind, title: page.title, path: page.path, internalPath: page.internalPath, channels: page.channels }));
    const redirects: RouteRedirect[] = (await repository.listRedirects())
      .sort((a, b) => a.fromPath.localeCompare(b.fromPath))
      .map((row) => ({ fromPath: row.fromPath, toPath: row.toPath, permanent: row.permanent }));
    const version = createHash('sha1').update(JSON.stringify({ pages: live, redirects })).digest('hex').slice(0, 16);
    return { version, pages: live, redirects };
  });
}

/** `GET /app/site/sitemap` — every live WEBSITE page a crawler may index: no `:param` pages, none whose live version says `noindex`. */
export async function sitemap(): Promise<SitemapEntry[]> {
  return layoutCached(`${SITE_CACHE}|sitemap`, async () => {
    const { pages, versions } = await livePages();
    return pages
      .filter((page) => page.channels.includes('WEBSITE') && isLive(page, versions) && !hasParam(page.path))
      .flatMap((page) => {
        const live = liveOf(page, versions);
        if (metaOf(live)?.noindex) return [];
        return [{ path: page.path, updatedAt: live?.publishedAt ?? page.updatedAt }];
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  });
}

/**
 * `GET /app/pages/:key?preview=` — a page resolved for this caller, as
 * `GET /app/layouts/:surface` resolves a surface. A CUSTOM page answers
 * its live version (404 while nothing is published or once archived); a
 * SYSTEM page answers its surface's live version or its defaults. With a
 * valid preview token naming this page, the draft — falling back to what
 * is live — is answered uncached.
 */
export async function resolvePage(key: string, query: PlaceQuery & { preview?: string | undefined }, roles: readonly string[] | undefined): Promise<PublicPage> {
  const page = await repository.findByKey(key);
  if (!page || page.archivedAt) throw new ApiError(404, 'NOT_FOUND', `No page "${key}"`);
  const versionKey = versionKeyOf(page);
  const base = { key: page.key, title: page.title, path: page.path, channels: page.channels };
  const ctx = await contextFor(page, query, roles);

  if (verifyPreviewToken(query.preview, { kind: 'page', ref: page.key })) {
    const row = await draftOrLive(versionKey);
    if (!row && page.kind === 'CUSTOM') throw new ApiError(404, 'NOT_FOUND', `Nothing to preview on "${key}" — save a draft first`);
    const blocks = row ? blocksOf(row) : defaultBlocks(page.surface!);
    const [resolved, meta] = await Promise.all([resolveBlocks(blocks, ctx), resolveMeta(metaOf(row))]);
    return { ...base, version: row?.number ?? 0, isDefault: !row, meta, blocks: shuffleAds(resolved), preview: true };
  }

  const prefix = `page:${page.id}`;
  const live = await layoutCached<{ number: number; blocks: Block[]; meta: PageMeta | null } | null>(`${prefix}|live`, async () => {
    const row = (await getVersions(versionKey)).live;
    return row ? { number: row.number, blocks: row.blocks, meta: row.meta } : null;
  });
  if (!live && page.kind === 'CUSTOM') throw new ApiError(404, 'NOT_FOUND', `Nothing is published on "${key}"`);
  const version = live?.number ?? 0;
  const blocks = live?.blocks ?? defaultBlocks(page.surface!);
  const answer = await layoutCached(resolveCacheKey(prefix, version, ctx), async () => {
    const [resolved, meta] = await Promise.all([resolveBlocks(blocks, ctx), resolveMeta(live?.meta)]);
    return { resolved, meta };
  });
  return { ...base, version, isDefault: !live, meta: answer.meta, blocks: shuffleAds(answer.resolved) };
}
