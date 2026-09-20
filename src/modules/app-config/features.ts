import { feature } from '../../shared/features';

/**
 * Features of `app-config` — Lot G (answer 144).
 *
 * The enum catalogue, the flow editor, the app-status gate and the platform
 * settings.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('system.flow-editor', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The enums and flow definitions the apps boot from, edited by the console\'s flow editor (Q83/Q148).',
  routes: ['/api/v1/config'],
});

feature('system.app-status', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The force-update / maintenance gate both apps read before sign-in, and the wizard limits.',
  routes: ['/api/v1/app/status', '/api/v1/app/limits'],
});

feature('system.branding', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'QR-9: the brand every surface draws — name, tagline, colours and logo URLs, DR 11 by default and retuned from Settings › Branding. Public: read before sign-in, cached five minutes.',
  routes: ['/api/v1/app/branding'],
});

feature('system.platform-settings', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The platform settings row: SLAs, floors, retention windows.',
  routes: ['/api/v1/settings/platform'],
});
