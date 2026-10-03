import { feature } from '../../shared/features';

/**
 * Features of `layouts` — LM-1 (27 Sep 2026).
 *
 * What each screen draws, in what order, for whom and when.
 */

feature('content.layouts', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE'],
  owner: 'senior',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'LM-1 (27 Sep 2026): layout management — the sections of the website pages and the app home screens, ordered, targeted by side, city and city stage, scheduled and hidden from the desk; draft, preview, publish, history and restore. Clients draw the published layout and fall back to their own order when there is none.',
  routes: ['/api/v1/layouts', '/api/v1/app/layouts'],
});
