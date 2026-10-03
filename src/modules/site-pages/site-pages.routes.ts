import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, authenticateOptional, requirePermission, requireRole } from '../../shared/auth';
import { publicReadLimiter } from '../../shared/security';
import {
  archivePageHandler,
  createPageHandler,
  createRedirectHandler,
  deleteRedirectHandler,
  discardDraftHandler,
  fromContentHandler,
  getPageHandler,
  listPagesHandler,
  listRedirectsHandler,
  patchPageHandler,
  previewHandler,
  previewTokenHandler,
  publicPageHandler,
  publishHandler,
  restorePageHandler,
  restoreVersionHandler,
  routesHandler,
  saveDraftHandler,
  sitemapHandler,
  versionsHandler,
} from './site-pages.controller';

/**
 * `/app/site` — public. The website's proxy reads the routing table on
 * every request it does not recognise (cached a minute on its side, and a
 * minute here), the apps read it for a deep link, a crawler reads the
 * sitemap. Public data only, keyed by IP like the other signed-out reads.
 */
export const appSiteRouter = Router();
appSiteRouter.get('/routes', publicReadLimiter, asyncHandler(routesHandler));
appSiteRouter.get('/sitemap', publicReadLimiter, asyncHandler(sitemapHandler));

/** `/app/pages/:key` — a page resolved, public like `/app/layouts/:surface`; a token, when sent, is read as its side. */
export const appPagesRouter = Router();
appPagesRouter.get('/:key', authenticateOptional, publicReadLimiter, asyncHandler(publicPageHandler));

/**
 * `/site` — the desk. Read with content.view, edit with content.edit,
 * discard and archive with content.delete, publish and restore with
 * content.approve; an address, and every redirect written by hand, with
 * content.addresses (the owner: "Only admins can change the addresses").
 */
export const siteRouter = Router();
siteRouter.use(authenticate, requireRole('ADMIN'));

siteRouter.get('/pages', requirePermission('content.view'), asyncHandler(listPagesHandler));
siteRouter.post('/pages', requirePermission('content.edit'), asyncHandler(createPageHandler));
// PB-6: published at once, so both the edit and the approve power are needed.
siteRouter.post('/pages/from-content/:slug', requirePermission('content.edit', 'content.approve'), asyncHandler(fromContentHandler));
siteRouter.get('/pages/:key', requirePermission('content.view'), asyncHandler(getPageHandler));
// The address inside the body needs content.addresses too — the controller checks it.
siteRouter.patch('/pages/:key', requirePermission('content.edit'), asyncHandler(patchPageHandler));
siteRouter.post('/pages/:key/archive', requirePermission('content.delete'), asyncHandler(archivePageHandler));
siteRouter.post('/pages/:key/restore-page', requirePermission('content.edit'), asyncHandler(restorePageHandler));

siteRouter.put('/pages/:key/draft', requirePermission('content.edit'), asyncHandler(saveDraftHandler));
siteRouter.delete('/pages/:key/draft', requirePermission('content.delete'), asyncHandler(discardDraftHandler));
siteRouter.get('/pages/:key/preview', requirePermission('content.view'), asyncHandler(previewHandler));
siteRouter.post('/pages/:key/preview-token', requirePermission('content.view'), asyncHandler(previewTokenHandler));
siteRouter.post('/pages/:key/publish', requirePermission('content.approve'), asyncHandler(publishHandler));
siteRouter.get('/pages/:key/versions', requirePermission('content.view'), asyncHandler(versionsHandler));
siteRouter.post('/pages/:key/versions/:number/restore', requirePermission('content.approve'), asyncHandler(restoreVersionHandler));

siteRouter.get('/redirects', requirePermission('content.view'), asyncHandler(listRedirectsHandler));
siteRouter.post('/redirects', requirePermission('content.addresses'), asyncHandler(createRedirectHandler));
// A removal is an address change AND a delete: both powers, as every DELETE on the platform names a delete power (RP-3).
siteRouter.delete('/redirects/:id', requirePermission('content.addresses', 'content.delete'), asyncHandler(deleteRedirectHandler));
