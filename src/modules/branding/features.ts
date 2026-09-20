import { feature } from '../../shared/features';

/**
 * Features of `branding` — QR-11 (17 Sep 2026).
 *
 * The brand manager: the draft, publish, the history, restore. The public
 * read of the live brand is `system.branding` on app-config.
 */

feature('system.brand-manager', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'QR-11: Settings › Brand & theme — the draft brand (words, colours, logos, website kit) with live previews and legibility checks, Publish to make it the release every surface draws, and the release history with one-click restore.',
  routes: ['/api/v1/branding'],
});
