import { feature } from '../../shared/features';

/**
 * Features of `forms` — FM-1 (27 Sep 2026).
 *
 * Forms made in Content › Forms, drawn by a page's Form block, answered into
 * a lead, a ticket or the form's own inbox — never into a platform record.
 */

feature('content.forms', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'FM-1 (27 Sep 2026): the form builder — screens of fields on the flow vocabulary, versioned draft → publish with history and restore; a public or signed-in door that checks every answer, records consent and sends it to a lead, a support ticket or the inbox; the desk lists, maps, exports and files the answers.',
  routes: ['/api/v1/forms', '/api/v1/app/forms'],
});
