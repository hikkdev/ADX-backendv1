import { feature } from '../../shared/features';

/**
 * Features of `support` — Lot G (answer 144).
 *
 * Tickets with a two-clock SLA (Lot D, Q53/Q91).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('support.tickets', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Support tickets: raised on the phone, queued, replied to, assigned and closed on the console.',
  routes: ['/api/v1/support'],
});

/**
 * Lot I: live chat for paid subscribers — the entitlement, the stream, the
 * desk's presence and inbox, the canned replies and the minute sweep.
 *
 * A KILL_SWITCH rather than a FEATURE: switched off, every live route
 * answers 503 FEATURE_OFF and `GET /support/live/status` answers
 * `entitled: false, reason: FEATURE_OFF` — the phones fall back to the
 * ticket thread, which never goes anywhere. Nothing is lost by turning it
 * off in the middle of a bad afternoon.
 */
feature('support.live-chat', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'platform',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'Live chat for paid subscribers: the entitlement read, the SSE thread, operator presence and auto-assignment, the desk inbox, canned replies and the first-response sweep.',
  jobs: ['live-chat-sla'],
});
