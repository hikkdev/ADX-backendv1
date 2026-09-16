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

/**
 * G6 (Q110): the publisher's booking report PDF and the spot-insights read,
 * mounted by bootstrap at `/publishers/me/bookings` ahead of the publishers
 * router — they live here because `publishers` cannot import `orders`
 * (`users` reaches `publishers`, and this module reaches `users`).
 */
export { publisherBookingRouter } from './publisher-report/booking-report.routes';

/**
 * Used by `campaigns` at launch: a booked spot becomes an order, and the whole
 * DR 03 chain — publisher accept, print, agent, install, OTP — runs from there
 * unchanged. Campaigns decide what is bought; this decides how it gets up.
 */
export { placeOrder } from './placement/placement.service';

/** Used by `order-milestones` to guard against acting on a finalised order. */
export { getOrderSummary } from './orders.queries';
/** K-B1: by order id, for the QR desk (registered on qr's ref-label port by bootstrap). */
export { findOrderLabels } from './orders.queries';

/**
 * Used by `suspension` for Lot A's STOP_OPEN_WORK: the orders still running on
 * a suspended spot, and the ordinary cancel that stops each of them. Cancelling
 * through this path rather than writing the status directly keeps the listing
 * freed and the notifications sent.
 */
export { findOpenOrdersForListings } from './orders.queries';

/**
 * Used by `account-lifecycle` for Lot A's closure review (Q21): the orders a
 * closing account is still on, from the demand side, and the offers its agent
 * profile has not answered.
 */
export { findOpenOrdersForAdvertiserUser, countPendingAgentOffers } from './orders.queries';

/** G11-1: used by `fraud` for the linked-accounts rail — a party's non-terminal orders, counted and valued in one aggregate. */
export { openOrderExposureFor } from './orders.queries';
export type { OpenOrderScope } from './orders.repository';
export { cancelOrder } from './verification/verification.service';

/** Used by `suspension`: a suspended agent's unanswered offers, handed back and re-offered. */
export { releaseAgentOffers } from './assignment/assignment.service';

/**
 * Used by `order-milestones` to issue a milestone plan for the jobs an agent is
 * holding. The dependency runs one way — that module reads orders, orders never
 * reads it — which is why the issuing lives there rather than in the accept.
 */
export { getAgentOrderIdsAwaitingWork, getAgentOrdersInWindow } from './orders.queries';

/** Used by jobs/publisher-timer. */
export { findPublisherTimerExpired } from './orders.queries';

/** Lot G (Q126/Q141): the code's A1–A8 ladder, for `scripts/seedConfig` to write as `flows.agent-job`. */
export { CODE_AGENT_JOB_LADDER } from './fulfilment/job-ladder';

/**
 * Lot B (B4b): the print job behind an order, reached through a port because
 * `print-partners` reads orders. Bootstrap fills it; unregistered, an order
 * has no job and the collect-prints step records nothing.
 */
export { registerPrintJobPort, resetPrintJobPort } from './print-job.port';
export type { PrintJobPort, PickupPoint, OrderPrintJob } from './print-job.port';

/**
 * Lot D (Q120): the print gate — whether an order's artwork is approved —
 * reached through a port because `campaigns` raises orders. Bootstrap fills
 * it with `campaigns.creativeGateForOrder`; unregistered, every order prints.
 */
export { registerCreativeGatePort, resetCreativeGatePort } from './creative-gate.port';
export type { CreativeGatePort, CreativeGateVerdict } from './creative-gate.port';

/** Used by jobs/agent-timer: the 25-minute offer window, enforced. */
export { expireAgentOffers, AGENT_RESPONSE_WINDOW_MINUTES } from './assignment/assignment.service';
export {
  AGENT_REJECTION_REASONS,
  AGENT_REJECTION_LABELS,
  OFFER_EXPIRED_REASON,
  rejectionText,
} from './assignment/rejection-reasons';
export type { AgentRejectionReason } from './assignment/rejection-reasons';
export { shortId, notifyAdmins, notifyAgent } from './orders.notify';

/**
 * Used by `order-milestones` for A12: the same derived "Available slots" the
 * order lane offers, applied to a visit. Pure, so sharing it shares no state.
 */
export { slotCandidates } from './scheduling/slot-candidates';
export type { SlotCandidate } from './scheduling/slot-candidates';

/**
 * G12-B: the live-position ping behind `POST /orders/:id/update-location`,
 * for `order-milestones` — a milestone visit's ping lands on its order's
 * agent-location columns, the store `GET /orders/:id/agent-location` reads.
 * The ownership check is the caller's; this only writes.
 */
export { updateAgentLocation } from './tracking/tracking.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
