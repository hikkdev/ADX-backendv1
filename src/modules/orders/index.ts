/**
 * Orders — the campaign booking lifecycle, from placement through publisher
 * acceptance, agent assignment, slot negotiation, installation, OTP
 * verification and admin approval.
 *
 * Split by lifecycle stage rather than by layer:
 *
 *   placement/     placing an order against a listing
 *   assignment/    choosing an agent, escalation after three rejections
 *   scheduling/    publisher accept/reject and slot negotiation
 *   fulfilment/    installation, both agent-led and publisher self-install
 *   verification/  completion OTP, admin approval, cancellation
 *   tracking/      site check-in and live agent location
 */
export { orderRouter } from './orders.routes';

/** Used by `order-milestones` to guard against acting on a finalised order. */
export { getOrderSummary } from './orders.queries';

/** Used by jobs/publisher-timer. */
export { findPublisherTimerExpired } from './orders.queries';
export { shortId } from './orders.notify';
