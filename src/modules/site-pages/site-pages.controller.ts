import type { Request, Response } from 'express';
import { hasPermission } from '../../shared/auth';
import { ApiError } from '../../shared/errors';
import { previewQuerySchema, publishSchema, resolveQuerySchema, saveDraftSchema } from '../layouts';
import { createPageSchema, createRedirectSchema, pageKeySchema, patchPageSchema } from './site-pages.schema';
import {
  archivePage,
  createFromContent,
  createPage,
  createRedirect,
  deleteRedirect,
  discardPageDraft,
  getPage,
  listPages,
  listRedirects,
  pagePreviewToken,
  pageVersions,
  previewPage,
  publishPage,
  resolvePage,
  restorePage,
  restorePageVersion,
  routesTable,
  savePageDraft,
  sitemap,
  updatePage,
} from './site-pages.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());
const actorOf = (req: Request) => ({ userId: req.user!.sub, req });

/** `:key` — a bad key names no page. */
function keyOf(req: Request): string {
  const parsed = pageKeySchema.safeParse(req.params['key']);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', `No page "${String(req.params['key'])}"`);
  return parsed.data;
}

/* ── Public ───────────────────────────────────────────────────────── */

/** `GET /app/site/routes` — the routing table. */
export async function routesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await routesTable() });
}

/** `GET /app/site/sitemap` — the website's indexable pages. */
export async function sitemapHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await sitemap() });
}

/** `GET /app/pages/:key?side=&city=&cityId=&stage=&preview=` — a page resolved for this caller; a token is read as its side. */
export async function publicPageHandler(req: Request, res: Response): Promise<void> {
  const parsed = resolveQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const page = await resolvePage(keyOf(req), parsed.data, req.user?.roles);
  if (page.preview) res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: page });
}

/* ── The desk: pages ──────────────────────────────────────────────── */

export async function listPagesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listPages() });
}

export async function createPageHandler(req: Request, res: Response): Promise<void> {
  const parsed = createPageSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.status(201).json({ success: true, data: await createPage(parsed.data, actorOf(req)) });
}

/** `POST /site/pages/from-content/:slug` — the route holds content.edit and content.approve; the page is published at once. */
export async function fromContentHandler(req: Request, res: Response): Promise<void> {
  const slug = pageKeySchema.safeParse(req.params['slug']);
  if (!slug.success) throw new ApiError(404, 'NOT_FOUND', `No page is published at "${String(req.params['slug'])}"`);
  res.status(201).json({ success: true, data: await createFromContent(slug.data, actorOf(req)) });
}

export async function getPageHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getPage(keyOf(req)) });
}

/**
 * `PATCH /site/pages/:key` — the title and channels behind `content.edit`
 * (the route); the address behind `content.addresses`, checked here. The
 * owner: "Only admins can change the addresses."
 */
export async function patchPageHandler(req: Request, res: Response): Promise<void> {
  const parsed = patchPageSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  if (parsed.data.path !== undefined && !hasPermission(req.user, 'content.addresses')) {
    throw new ApiError(403, 'FORBIDDEN', 'Only an admin with content.addresses may change an address', { missing: ['content.addresses'] });
  }
  res.json({ success: true, data: await updatePage(keyOf(req), parsed.data, actorOf(req)) });
}

export async function archivePageHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await archivePage(keyOf(req), actorOf(req)) });
}

export async function restorePageHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await restorePage(keyOf(req), actorOf(req)) });
}

/* ── The desk: versions ───────────────────────────────────────────── */

export async function saveDraftHandler(req: Request, res: Response): Promise<void> {
  const parsed = saveDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await savePageDraft(keyOf(req), parsed.data, actorOf(req)) });
}

export async function discardDraftHandler(req: Request, res: Response): Promise<void> {
  await discardPageDraft(keyOf(req), actorOf(req));
  res.json({ success: true, data: { message: 'Draft discarded' } });
}

/** `GET /site/pages/:key/preview?side=&cityId=&version=draft|<n>` — the public shape, for a version that may not be live. */
export async function previewHandler(req: Request, res: Response): Promise<void> {
  const parsed = previewQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const { version, ...place } = parsed.data;
  res.json({ success: true, data: await previewPage(keyOf(req), version, place, req.user?.roles) });
}

export async function publishHandler(req: Request, res: Response): Promise<void> {
  const parsed = publishSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await publishPage(keyOf(req), parsed.data, actorOf(req)) });
}

export async function versionsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await pageVersions(keyOf(req)) });
}

export async function restoreVersionHandler(req: Request, res: Response): Promise<void> {
  const number = Number(req.params['number']);
  if (!Number.isInteger(number) || number < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'A version number is a whole number from 1');
  res.json({ success: true, data: await restorePageVersion(keyOf(req), number, actorOf(req)) });
}

export async function previewTokenHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await pagePreviewToken(keyOf(req)) });
}

/* ── The desk: redirects ──────────────────────────────────────────── */

export async function listRedirectsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listRedirects() });
}

export async function createRedirectHandler(req: Request, res: Response): Promise<void> {
  const parsed = createRedirectSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  res.status(201).json({ success: true, data: await createRedirect(parsed.data, actorOf(req)) });
}

export async function deleteRedirectHandler(req: Request, res: Response): Promise<void> {
  await deleteRedirect(String(req.params['id']), actorOf(req));
  res.json({ success: true, data: { message: 'Redirect deleted' } });
}
