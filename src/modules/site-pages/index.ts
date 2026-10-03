/**
 * Site pages — PB-1 (27 Sep 2026): the site's pages, their addresses and
 * where the old ones go.
 *
 * Nine SYSTEM pages the website draws itself and the CUSTOM pages Studio
 * builds from blocks, each with a public address (`content.addresses` to
 * change it; every change leaves a permanent redirect), hand-written
 * redirects, the routing table the website's proxy and the apps' deep links
 * consult (`GET /app/site/routes`), the sitemap, and a page resolved per
 * caller (`GET /app/pages/:key`) the way `layouts` resolves a surface.
 */
export { siteRouter, appSiteRouter, appPagesRouter } from './site-pages.routes';
export { routesTable, sitemap, resolvePage, pageByKey } from './site-pages.service';
export type { PageSummary, PageDetail, RedirectView, RoutesTable, RoutePage, RouteRedirect, SitemapEntry, PublicPage } from './site-pages.service';
export { checkSitePath, checkRedirectSource, checkRedirectTarget, checkPageKey, RESERVED_FIRST_SEGMENTS, PAGE_KEY } from './paths';
export type { PathCheck, PathScope } from './paths';
export { PAGE_TEMPLATES, TEMPLATE_LABEL, templateBlocks } from './templates';
export type { PageTemplate } from './templates';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
