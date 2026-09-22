import { feature } from '../../shared/features';

/**
 * Features of `leads` — Lot G (answer 144).
 *
 * The agent's prospects (DR 06; Lot D, Q93).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('agent.leads', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Leads near the agent, contact / visit / convert, the transactional import.',
  routes: ['/api/v1/leads'],
});

/**
 * LH1 (the Lead Hunt, 22 Sep 2026): the computed temperature — the score
 * behind hot / warm / cold, the sources' learned quality, the nightly
 * re-score. On from the start: the score is a read the desk and the app
 * already print; nothing gates on it.
 */
feature('leads.scoring', {
  surfaces: ['APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'Hot / warm / cold from five signals, the sources with their learned quality, the nightly re-score.',
  routes: ['/api/v1/leads/sources', '/api/v1/leads/:leadId/flag-hot', '/api/v1/leads/:leadId/rescore'],
  jobs: ['lead-scoring'],
});

/**
 * LH2 (the Lead Hunt): the twelve stages (D12), the loss reasons (D11),
 * the retention watch that reads the catch off the account and pays it,
 * the sixty-day recycle, the funnel.
 */
feature('leads.pipeline', {
  surfaces: ['APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'The twelve pipeline stages, loss reasons, the retention watch (ACTIVATED / RETAINED pay), the recycle, the funnel.',
  routes: ['/api/v1/leads/funnel', '/api/v1/leads/:leadId/stage', '/api/v1/leads/:leadId/engaged', '/api/v1/leads/:leadId/proposed', '/api/v1/leads/:leadId/lost'],
  jobs: ['lead-pipeline'],
});

/**
 * LH3 (the Lead Hunt, D4 / D9): where leads come from — the directory
 * feeds behind one port, the inbound doors (the website form, the SITE QR
 * poster, the agent's card, a referral link), the lead-form ad webhooks,
 * the referrals with their wallet credit, routing to the nearest agent.
 */
feature('leads.sources', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'Directory feeds (Google Places live, five partner adapters), inbound forms and posters, lead-form ad webhooks, referrals with a wallet credit, routing.',
  routes: ['/api/v1/leads/feeds', '/api/v1/leads/inbound', '/api/v1/leads/referrals', '/api/v1/webhooks/leads'],
});

/**
 * LH4 (the Lead Hunt): street capture — "Spot a lead" on the agent app's
 * centre disc: a photographed wall or shop front, the side, the category,
 * a number if they got one, the fix; the same wall within 30 m is refused.
 */
feature('leads.capture', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'An agent spots a lead in the street: photos, side, category, the fix; dedup within 30 m; the lead lands on their own list.',
  routes: ['/api/v1/leads/capture'],
});

/**
 * LH5 (the Lead Hunt, D3 / D7 / D8): the hunting map — one viewport
 * endpoint for the ops map and the agent's (clusters above sixty km²,
 * pins below), the heat (demand over supply), claims with a 72-hour hold
 * under tier caps and a cooldown, territories that route new leads,
 * priority zones with a top-up under a cap, the hourly lapse, the three
 * alerts (a hot lead within a kilometre, a claim about to lapse, a link
 * opened).
 */
feature('leads.map', {
  surfaces: ['APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'The hunting map: viewport clusters / pins, the heat, claims (72 h, caps, cooldown), territories, priority zones, the lapse sweep and the nearby-hot alerts.',
  routes: ['/api/v1/leads/map', '/api/v1/leads/territories', '/api/v1/leads/priority-zones', '/api/v1/leads/:leadId/claim', '/api/v1/leads/:leadId/release'],
  jobs: ['lead-claim-sweep'],
});

/**
 * LH6 (D5, D13, D14): the outreach hub — one channel port over SMS, email,
 * WhatsApp (BSP-selectable), Instagram DM, Messenger, Business Messages,
 * telephony (click-to-call, recordings, missed call, IVR, callbacks) and
 * the touches logged by hand; sequences per side and temperature; the
 * inbound and tele-team queues; the funnel by channel. Every adapter is
 * NOT_CONFIGURED until its card under Settings › Integrations › Channels
 * is filled.
 */
feature('leads.outreach', {
  surfaces: ['APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'The outreach hub: the unified thread per lead, sends over SMS / email / WhatsApp / the Meta DMs / Business Messages, click-to-call with consented recordings, missed-call and IVR doors, callback tasks, sequences per side and temperature, the inbound and tele-team queues, the funnel by channel.',
  routes: [
    '/api/v1/leads/outreach/channels',
    '/api/v1/leads/outreach/inbox',
    '/api/v1/leads/outreach/tele-queue',
    '/api/v1/leads/outreach/funnel',
    '/api/v1/leads/sequences',
    '/api/v1/leads/sequences/preview',
    '/api/v1/leads/sequences/:sequenceId',
    '/api/v1/leads/:leadId/thread',
    '/api/v1/leads/:leadId/messages',
    '/api/v1/leads/:leadId/touch',
    '/api/v1/leads/:leadId/call',
    '/api/v1/leads/:leadId/call-log',
    '/api/v1/leads/:leadId/callback',
    '/api/v1/leads/:leadId/sequence',
    '/api/v1/webhooks/outreach/meta',
    '/api/v1/webhooks/outreach/gupshup',
    '/api/v1/webhooks/outreach/interakt',
    '/api/v1/webhooks/outreach/google-business',
    '/api/v1/webhooks/outreach/telephony/status',
    '/api/v1/webhooks/outreach/telephony/missed-call',
    '/api/v1/webhooks/outreach/telephony/answer',
    '/api/v1/webhooks/outreach/telephony/ivr',
    '/api/v1/webhooks/outreach/telephony/ivr/choice',
  ],
  jobs: ['lead-outreach-tick'],
});

/**
 * LH10: anti-gaming and quality — the integrity scan's four patterns
 * (self-referral, a number reused across leads, a capture burst, a
 * lead-form replay), each a flag a person decides; the nightly QA draw
 * over visits and recorded calls with the evidence they carry and the
 * agent's quality score; and the clawback on an activation reward when
 * the account closes or its business comes down inside thirty days.
 */
feature('leads.integrity', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'growth',
  kind: 'FEATURE',
  launch: 'on',
  description: 'The integrity scan and its flags, QA sampling of visits and recorded calls with the agent quality score, and the activation clawback.',
  routes: ['/api/v1/leads/flags', '/api/v1/leads/qa', '/api/v1/leads/quality', '/api/v1/leads/clawbacks/run'],
  jobs: ['lead-integrity'],
});

/**
 * LH7 (D6, D14): digital conversion — the invite link `adx.in/j/<code>`
 * (thirty days, re-issuable, every open a signal), the public landing
 * with the side's hook and the proposals, the OTP door that opens the
 * account and converts the lead through the link, a callback, a slot, and
 * the three proposal kinds; the landing copy per side under the flow
 * editor.
 */
feature('leads.invites', {
  surfaces: ['APP_AGENT', 'CONSOLE', 'WEBSITE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'The invite link and its landing: share, opens as intent, the OTP door that converts through the link, callback and slot asks, proposals (rate estimate, campaign estimate, package quote), the landing copy per side.',
  routes: [
    '/api/v1/leads/landing-copy',
    '/api/v1/leads/:leadId/invite',
    '/api/v1/leads/:leadId/proposals',
    '/api/v1/leads/:leadId/proposals/:proposalId/accept',
    '/api/v1/j/:code',
    '/api/v1/j/:code/otp',
    '/api/v1/j/:code/verify',
    '/api/v1/j/:code/callback',
    '/api/v1/j/:code/slot',
    '/api/v1/j/:code/proposals/:proposalId/accept',
    '/api/v1/j/:code/link',
  ],
});
