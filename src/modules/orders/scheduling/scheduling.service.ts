import { getListingWithPublisher, setListingAvailability } from '../../listings';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyAgent, notifyUser, shortId } from '../orders.notify';

const MAX_SLOT_COUNTERS = 3;

/** Loads an order and checks the caller is the publisher who owns its listing. */
async function requirePublisherOrder(orderId: string, publisherUserId: string) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  return order;
}

export async function publisherAcceptOrder(
  orderId: string,
  publisherUserId: string,
  meetingPlace: string,
) {
  const order = await requirePublisherOrder(orderId, publisherUserId);
  if (order.status !== 'PENDING_PUBLISHER') throw new Error('WRONG_STATUS');

  const updated = await repository.update(orderId, {
    status: 'PENDING_PRINT',
    publisherAcceptedAt: new Date(),
    meetingPlace,
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
