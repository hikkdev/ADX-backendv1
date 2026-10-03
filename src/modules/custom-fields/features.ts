import { feature } from '../../shared/features';

/**
 * Features of `custom-fields` — CF-1 (27 Sep 2026).
 *
 * Extra questions on a publisher, advertiser, listing or lead, kept beside
 * the record and never in its columns.
 */

feature('settings.custom-fields', {
  surfaces: ['APP_USER', 'CONSOLE', 'WEBSITE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'CF-1 (27 Sep 2026): custom fields per record type — definitions made under Settings › Custom fields (kind, options, required, where shown, whether the owner may answer), values kept beside the publisher, advertiser, listing or lead; the desk answers on every detail page, the owner answers their own in the apps and on the website.',
  routes: ['/api/v1/custom-fields', '/api/v1/app/custom-fields'],
});
