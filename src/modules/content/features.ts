import { feature } from '../../shared/features';

/**
 * Features of `content` — CT-1 (24 Sep 2026).
 *
 * The pages ADX writes itself, beside the thirteen fixed legal documents.
 */

feature('content.pages', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'CT-1 (24 Sep 2026): pages ADX writes and publishes itself — help articles, guides, a policy the thirteen legal kinds do not cover, a page the website needs. Addressed by slug, versioned draft → published with history and rollback, read without a token.',
  routes: ['/api/v1/content'],
});
