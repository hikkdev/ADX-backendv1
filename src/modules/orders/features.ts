import { feature } from '../../shared/features';

/**
 * Features of `orders` — Lot G (answer 144).
 *
 * The booking loop from placement to installation, in three hands: the
 * advertiser's, the publisher's, the agent's — and ops' moves over it.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('orders.booking', {
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  owner: 'marketplace',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Placing an order, the publisher accepting or rejecting it, the slot negotiation, and the timers that expire an unanswered offer.',
  routes: ['/api/v1/orders'],
  jobs: ['publisher-timer'],
});

feature('orders.self-install', {
  surfaces: ['APP_USER'],
  owner: 'marketplace',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The publisher installs the creative themselves: collect prints, capture condition, check in, capture installation.',
  routes: ['/api/v1/orders/:id/self-install', '/api/v1/orders/:id/choose-fulfilment'],
});

feature('orders.agent-fulfilment', {
  surfaces: ['APP_AGENT', 'APP_USER', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The agent\'s job: offers, accept / reject, slots, prints pickup, check-in, condition and installation capture, OTP handover, live location and evidence; the 25-minute acceptance window.',
  routes: [
    '/api/v1/orders/agents/:agentId/offers',
    '/api/v1/orders/:id/accept-agent',
    '/api/v1/orders/:id/reject-agent',
    '/api/v1/orders/:id/propose-slot',
    '/api/v1/orders/:id/slot-candidates',
    '/api/v1/orders/:id/collect-prints',
    '/api/v1/orders/:id/pickup-code',
    '/api/v1/orders/:id/checkin',
    '/api/v1/orders/:id/capture-condition',
    '/api/v1/orders/:id/reject-condition',
    '/api/v1/orders/:id/capture-installation',
    '/api/v1/orders/:id/submit-installation',
    '/api/v1/orders/:id/request-otp',
    '/api/v1/orders/:id/verify-otp',
    '/api/v1/orders/:id/update-location',
    '/api/v1/orders/:id/agent-location',
    '/api/v1/orders/:id/evidence',
  ],
  jobs: ['agent-timer'],
});

feature('orders.ops-moves', {
  surfaces: ['CONSOLE'],
  owner: 'marketplace',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Ops over an order: assign or reassign the agent, approve, cancel, end the campaign, mark print-ready, and act for a publisher who is not on the phone.',
  routes: [
    '/api/v1/orders/:id/ops',
    '/api/v1/orders/:id/assign-agent',
    '/api/v1/orders/:id/reassign-agent',
    '/api/v1/orders/:id/approve',
    '/api/v1/orders/:id/cancel',
    '/api/v1/orders/:id/end-campaign',
    '/api/v1/orders/:id/print-ready',
  ],
});
