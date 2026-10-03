import { feature } from '../../shared/features';

/**
 * Features of `site-pages` — PB-1 (27 Sep 2026).
 *
 * The site's pages, their addresses and redirects, and the custom pages
 * Studio builds. Declared as `content.site-pages` rather than the contract's
 * `content.pages`: that key is the `content` module's (CT-1, the text pages)
 * and a feature key is declared once.
 */

feature('content.site-pages', {
  surfaces: ['WEBSITE', 'APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "PB-1 (27 Sep 2026): the site's pages — the nine the website draws itself and the custom pages Studio builds from blocks — each with a public address only an admin with content.addresses may change (every change leaves a permanent redirect), hand-written redirects, the routing table the website's proxy and the apps' deep links consult, the sitemap, and a page resolved per caller like a layout surface.",
  routes: ['/api/v1/site', '/api/v1/app/site', '/api/v1/app/pages'],
});
