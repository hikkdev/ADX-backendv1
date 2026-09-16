import { feature } from '../../shared/features';

/**
 * Features of `notifications` — Lot G (answer 144).
 *
 * The in-app feed and the dispatcher every outbound message passes through
 * (Lot E, Q87/Q128/Q147).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('comms.inbox', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The notification feed, read marks and the per-channel preferences.',
  routes: ['/api/v1/notifications'],
});

feature('comms.dispatcher', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'The sender job: renders and sends every queued delivery on its rail, three attempts, and the rails\' delivery-report webhooks.',
  routes: [
    '/api/v1/comms',
    '/api/v1/webhooks/msg91',
    '/api/v1/webhooks/twilio',
  ],
  jobs: ['notification-sender'],
});

feature('comms.templates', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The outbound templates, the events catalogue and the SMS kinds.',
  routes: [
    '/api/v1/comms/templates',
    '/api/v1/comms/events',
    '/api/v1/comms/sms-kinds',
  ],
});

feature('comms.delivery-log', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The masked delivery log, a resend, and the CSV export.',
  routes: ['/api/v1/comms/deliveries'],
});

feature('comms.push', {
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  owner: 'platform',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    "G6 (Q103/133): the device registry under /users/me/devices and the dispatcher's push rail. Off: a phone cannot register a token and the routes answer 503 FEATURE_OFF.",
});

feature('comms.unsubscribe', {
  surfaces: ['WEBSITE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The unsubscribe link at the foot of every email.',
  routes: ['/api/v1/comms/unsubscribe'],
});
