import { feature } from '../../shared/features';

/**
 * Features of `kyc` — Lot G (answer 144).
 *
 * The four review flows and the desk they share; Digio as the provider with
 * MANUAL as the fallback (Lot D, Q129; Lot G: escalation).
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('kyc.advertiser', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Advertiser KYC: submitted on the phone, reviewed per document on the desk.',
  routes: ['/api/v1/advertiser-kyc'],
});

feature('kyc.user-liveness', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot D (Q131): the liveness video every person records once.',
  routes: ['/api/v1/user-kyc'],
});

feature('kyc.agent', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Agent KYC, reviewed by ops.',
  routes: ['/api/v1/agent-kyc'],
});

feature('kyc.employee', {
  surfaces: ['CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Employee KYC, reviewed by ops.',
  routes: ['/api/v1/employee-kyc'],
});

feature('kyc.digio', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'KILL_SWITCH',
  launch: 'on',
  description:
    'Digio as the KYC provider: initiate, status, restart, the webhook, and the five-minute probe that moves DIGIO ↔ DEGRADED. Off: every initiate answers 503 KYC_PROVIDER_UNAVAILABLE and the desk works MANUAL.',
  routes: [
    '/api/v1/advertiser-kyc/me/digio',
    '/api/v1/advertiser-kyc/:id/digio',
    '/api/v1/publishers/me/kyc/digio',
    '/api/v1/publishers/:publisherId/kyc/digio',
    '/api/v1/publishers/kyc-queue/:publisherId/digio',
    // Lot N: the print partner's two doors.
    '/api/v1/print-partners/me/kyc/digio',
    '/api/v1/print-partner-kyc/:id/digio',
    '/api/v1/webhooks/digio',
  ],
  jobs: ['kyc-provider-probe'],
});

feature('kyc.verification-backup', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE', 'WEBSITE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Cashfree Phase 1 (1 Oct 2026): the verification layer — Cashfree Secure ID as Digio\'s automatic backup (a session of single checks on ADX\'s own screens, handed out only with the backup ON to a client that says `supports: [\'CASHFREE\']`), every provider call recorded as an attempt with a breaker per provider, the desk\'s attempt list, health read and "Resend on backup", Cashfree\'s webhook, and the two-minute status sweep.',
  routes: ['/api/v1/verification', '/api/v1/webhooks/cashfree/verification'],
  jobs: ['verification-status-sweep'],
});

feature('kyc.entity-type', {
  surfaces: ['APP_USER', 'CONSOLE', 'WEBSITE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Phase D (1 Oct 2026): the legal form a publisher, advertiser or print partner verifies as — asked at the Digio start (409 ENTITY_TYPE_REQUIRED) and it picks which of the 25 Digio workflows runs.',
  routes: ['/api/v1/kyc'],
});

feature('kyc.desk-intake', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "Lot N (14 Sep 2026): KYC from the desk — requested from the console (Digio on the party's behalf, or a notice to come by), recorded at the desk on their behalf, and the person's presence attested by the admin who met them. N3-B: the one-click Digio request on every party — agents and employees included.",
  routes: [
    '/api/v1/publishers/kyc-queue/:publisherId/request',
    '/api/v1/advertiser-kyc/:id/request',
    '/api/v1/agent-kyc/:agentId/request',
    '/api/v1/employee-kyc/:employeeId/request',
    '/api/v1/user-kyc/:userId/attest',
  ],
});

feature('kyc.escalation', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "Q127: a KYC case escalates from age past N x SLA, a fraud link or a reviewer's flag — assisting the reviewer, never deciding.",
  jobs: ['kyc-escalation'],
});

feature('kyc.purge', {
  surfaces: ['BACKEND'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Q127: verified identity images and liveness videos purged after the retention window.',
  jobs: ['kyc-purge'],
});
