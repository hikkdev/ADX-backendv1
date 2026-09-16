import { getListingWithPublisher, setListingAvailability } from '../../listings';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyAgent, notifyUser, shortId } from '../orders.notify';
import { slotCandidates, type SlotCandidate } from './slot-candidates';

const MAX_SLOT_COUNTERS = 3;

/** How far ahead the slot sheet looks for bands. */
const SLOT_HORIZON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A7 — the times the agent may propose, for the drawn picker.
 *
 * Only while a proposal is the agent's to make (their own order, at
 * SLOT_PROPOSED with no time on it yet — the state `propose-slot` accepts).
 * Derived from the clock, the booking's dates and the publisher's other
 * confirmed slots; see slot-candidates.ts for the rule.
 */
export async function agentSlotCandidates(
  orderId: string,
  agentProfileId: string,
  now: Date = new Date(),
): Promise<SlotCandidate[]> {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');

  const publisherId = order.listing.publisher?.id ?? null;
  const horizonEnd = new Date(now.getTime() + SLOT_HORIZON_DAYS * DAY_MS);
  const taken = publisherId
    ? await repository.findConfirmedSlotsForPublisher(publisherId, now, horizonEnd)
    : [];

  return slotCandidates({
    now,
    from: order.startDate,
    to: order.endDate,
    taken,
    horizonDays: SLOT_HORIZON_DAYS,
  });
}

/** Loads an order and checks the caller is the publisher who owns its listing. */
async function requirePublisherOrder(orderId: string, publisherUserId: string) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  return order;
}

/**
 * Where the agent goes to collect the material.
 *
 * The publisher's own address, given at sign-up — not something the accept
 * screen asks for. City and state stand in where no street address was
 * captured, which is better than nothing to route by and honest about being
 * approximate. An override is accepted for the booking where the publisher is
 * somewhere else that day.
 */
export function meetingPointFor(
  publisher: { address: string | null; city: string | null; state: string | null } | null,
  override?: string,
): string {
  const chosen = override?.trim();
  if (chosen) return chosen;
  const registered = publisher?.address?.trim();
  if (registered) return registered;
  const coarse = [publisher?.city, publisher?.state].filter(Boolean).join(', ').trim();
  if (coarse) return coarse;
  throw new Error('NO_MEETING_PLACE');
}

export async function publisherAcceptOrder(
  orderId: string,
  publisherUserId: string,
  meetingPlace?: string,
) {
  const order = await requirePublisherOrder(orderId, publisherUserId);
  if (order.status !== 'PENDING_PUBLISHER') throw new Error('WRONG_STATUS');

  const updated = await repository.update(orderId, {
    status: 'PENDING_PRINT',
    publisherAcceptedAt: new Date(),
    meetingPlace: meetingPointFor(order.listing.publisher, meetingPlace),
  });

  Promise.all([
    notifyUser(order.advertiserId, 'Order accepted', 'The publisher accepted your order.', orderId),
    notifyAdmins('Order ready for print', `Order ${shortId(orderId)} accepted by publisher.`, orderId),
  ]).catch(() => {});

  return updated;
}

export async function publisherRejectOrder(
  orderId: string,
  publisherUserId: string,
  reason?: string,
) {
  const order = await requirePublisherOrder(orderId, publisherUserId);
  if (order.status !== 'PENDING_PUBLISHER') throw new Error('WRONG_STATUS');

  const updated = await repository.update(orderId, {
    status: 'PUBLISHER_REJECTED',
    publisherRejectedAt: new Date(),
    publisherRejectionReason: reason,
  });

  Promise.all([
    notifyUser(
      order.advertiserId,
      'Order rejected',
      'The publisher rejected your order. Check similar listings.',
      orderId,
    ),
    notifyAdmins('Publisher rejected order', `Order ${shortId(orderId)} was rejected.`, orderId),
  ]).catch(() => {});

  return updated;
}

export async function agentProposeSlot(orderId: string, agentProfileId: string, slotTime: Date) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');

  const updated = await repository.update(orderId, { slotTime, slotProposedAt: new Date() });

  const listing = await getListingWithPublisher(order.listingId);
  if (listing?.publisher?.userId) {
    notifyUser(
      listing.publisher.userId,
      'Agent proposed a meeting time',
      `The agent proposed a time slot for order ${shortId(orderId)}.`,
      orderId,
    ).catch(() => {});
  }

  return updated;
}

export async function publisherConfirmSlot(orderId: string, publisherUserId: string) {
  const order = await requirePublisherOrder(orderId, publisherUserId);
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');

  const updated = await repository.update(orderId, {
    status: 'SLOT_CONFIRMED',
    slotConfirmedAt: new Date(),
  });

  // Mark listing occupied as soon as the slot is locked in, not at completion —
  // otherwise a second order could be placed against the same slot.
  await setListingAvailability(order.listingId, false);

  await notifyAgent(
    order.agentId,
    'Slot confirmed — installation unlocked',
    'Publisher confirmed your slot. Collect prints to begin.',
    orderId,
  ).catch(() => {});

  return updated;
}

export async function publisherCounterSlot(
  orderId: string,
  publisherUserId: string,
  counterNote?: string,
) {
  const order = await requirePublisherOrder(orderId, publisherUserId);
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');
  if (order.slotCounterCount >= MAX_SLOT_COUNTERS) throw new Error('COUNTER_LIMIT_REACHED');

  // Clearing slotTime returns the order to "awaiting a proposal" without
  // changing its status.
  const updated = await repository.update(orderId, {
    slotCounterCount: { increment: 1 },
    notes: counterNote,
    slotTime: null,
    slotProposedAt: null,
  });

  await notifyAgent(
    order.agentId,
    'Publisher rejected your slot',
    counterNote ?? 'Propose a new time.',
    orderId,
  ).catch(() => {});

  return updated;
}
