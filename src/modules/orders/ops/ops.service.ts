import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { publisherAcceptOrder, publisherConfirmSlot } from '../scheduling/scheduling.service';
import { agentCollectPrints } from '../fulfilment/fulfilment.service';

/**
 * Lot D (Q51/Q90) — ops moves on an order.
 *
 * Three of the four overrides the owner allowed (the fourth, reassign-agent,
 * lives beside the other assignment rules). Each one calls the ordinary
 * service with the party's own identity resolved from the order, so the
 * order moves exactly as it would have had the party tapped — the same
 * status, the same stamps, the same notifications — and the audit row the
 * controller writes (`ORDER_OPS_OVERRIDE`) is what says ADX did it, and why.
 *
 * Each is gated on the window the party was given having closed: the
 * override exists for a party who is not answering, never for one who has
 * not yet had the chance. Never check-in, photographs or the OTP — those are
 * the proof a person was at the site, and ADX cannot give it for them.
 */

/** How long a publisher has to answer a proposed slot before ops may confirm it. */
export const SLOT_ANSWER_WINDOW_HOURS = 24;

export type OpsOverride = 'ACCEPT_PUBLISHER' | 'CONFIRM_SLOT' | 'COLLECT_PRINTS';

/**
 * The publisher accepted out of band — on the phone, at the door — and the
 * 30-minute window has lapsed. `consentNote` records how they said yes; it
 * travels on the audit row rather than the order.
 */
export async function opsAcceptPublisher(
  orderId: string,
  _input: { reason: string; consentNote: string },
  now: Date = new Date(),
) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_PUBLISHER') throw new Error('WRONG_STATUS');
  if (!order.publisherTimerExpiry || order.publisherTimerExpiry.getTime() > now.getTime()) {
    throw new Error('OPS_WINDOW_OPEN');
  }
  const publisherUserId = order.listing.publisher?.userId;
  if (!publisherUserId) throw new Error('NO_PUBLISHER_ACCOUNT');
  return publisherAcceptOrder(orderId, publisherUserId);
}

/** The agent proposed a time and the publisher has said nothing for a day. */
export async function opsConfirmSlot(orderId: string, _input: { reason: string }, now: Date = new Date()) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');
  const proposedAt = order.slotTime ? order.slotProposedAt : null;
  if (!proposedAt || now.getTime() - proposedAt.getTime() < SLOT_ANSWER_WINDOW_HOURS * 60 * 60 * 1000) {
    throw new Error('OPS_WINDOW_OPEN');
  }
  const publisherUserId = order.listing.publisher?.userId;
  if (!publisherUserId) throw new Error('NO_PUBLISHER_ACCOUNT');
  return publisherConfirmSlot(orderId, publisherUserId);
}

/**
 * The agent is at the site — their check-in says so — and the collect-prints
 * tap did not land. Recorded for them; a no-op once IN_PROGRESS, as the
 * agent's own retry is.
 */
export async function opsCollectPrints(orderId: string, _input: { reason: string }) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (!order.agentId) throw new Error('WRONG_STATUS');
  const checkIn = await repository.findCheckIn(orderId);
  if (!checkIn) throw new Error('OPS_NO_CHECKIN');
  return agentCollectPrints(orderId, order.agentId);
}
