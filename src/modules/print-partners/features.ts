import { feature } from '../../shared/features';

/**
 * Features of `print-partners` — Lot G (answer 144), Lot H (Q147).
 *
 * The print shops as payees (Lot B, Q50/B4b) and, since Lot H, as a floor
 * of their own in the user app.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net. The floor's
 * routes carry `requireFeature` on the route instead, so the two switches
 * below kill exactly the partner-facing half.
 */

feature('print.partners', {
  surfaces: ['CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Print partners: created, edited, deactivated, reactivated, activated for the app; their ledger, rate card and quote history.',
  routes: ['/api/v1/print-partners'],
});

feature('print.jobs', {
  surfaces: ['CONSOLE', 'APP_AGENT'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'A print job on an order and the cost approval that pays the partner.',
  routes: ['/api/v1/orders/:id/print-job'],
});

feature('partners.print-floor', {
  surfaces: ['APP_USER'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot H (Q147): the print partner\'s own floor — profile and rate card, the assigned jobs walked to handover by scan, the wallet, withdrawals, payout methods and the monthly invoice.',
});

feature('print.partner-kyc', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'platform',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "Lot N: the print partner's KYC on three paths — the partner's own documents or Digio session from the phone, the desk recording it on their behalf, the desk requesting it (Digio on their behalf, or by hand) — reviewed per document on the same workbench as the publisher's and the advertiser's; purged and escalated with them.",
  routes: ['/api/v1/print-partner-kyc', '/api/v1/print-partners/me/kyc'],
});

feature('partners.quotes', {
  surfaces: ['APP_USER', 'CONSOLE'],
  owner: 'finance',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Lot H (Q147): quote requests on an order print — ops invite the partners in reach, partners quote until the deadline, the lowest is awarded unless ops override with a note; the nightly expiry re-invites once. G13-B: the desk\'s list across orders.',
  routes: ['/api/v1/print-quote-requests'],
  jobs: ['print-quote-expiry'],
});
