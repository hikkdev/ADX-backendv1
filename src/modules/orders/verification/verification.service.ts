import bcrypt from 'bcryptjs';
import { setListingAvailability } from '../../listings';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyAgent, notifyUser, shortId } from '../orders.notify';

const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * Completion OTP.
 *
 * The publisher receives a code and reads it out to the agent on site — proof
 * the agent was physically there with the publisher. Requesting again while
 * already PENDING_OTP simply reissues.
 *
 * Note the plaintext code is stored alongside the hash
 * (`completionOtpPlain`) so support can read it back; both are cleared on
 * successful verification.
 */
export async function requestCompletionOtp(orderId: string, agentProfileId: string) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'IN_PROGRESS' && order.status !== 'PENDING_OTP') {
    throw new Error('WRONG_STATUS');
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await bcrypt.hash(otp, 10);

  await repository.update(orderId, {
    status: 'PENDING_OTP',
    completionOtp: hash,
    completionOtpPlain: otp,
    completionOtpExpiry: new Date(Date.now() + OTP_TTL_MS),
  });

  if (order.listing.publisher?.userId) {
    notifyUser(
      order.listing.publisher.userId,
      `Completion code: ${otp}`,
      'Share this code with the agent. Valid for 10 minutes.',
      orderId,
    ).catch(() => {});
  }

  return { success: true };
}

export async function verifyCompletionOtp(
  orderId: string,
  agentProfileId: string,
  otp: string,
) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'PENDING_OTP') throw new Error('WRONG_STATUS');
  if (!order.completionOtp || !order.completionOtpExpiry) throw new Error('OTP_NOT_REQUESTED');
  if (new Date() > order.completionOtpExpiry) throw new Error('OTP_EXPIRED');

  if (!(await bcrypt.compare(otp, order.completionOtp))) throw new Error('OTP_INVALID');

  const updated = await repository.update(orderId, {
    status: 'PENDING_APPROVAL',
    completionOtp: null,
    completionOtpPlain: null,
  });

  notifyAdmins(
    'Order ready for approval',
    `Order ${shortId(orderId)} OTP verified.`,
    orderId,
  ).catch(() => {});

  return updated;
}

/** Admin sign-off. Notifies all three parties. */
export async function approveOrder(orderId: string) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_APPROVAL') throw new Error('WRONG_STATUS');

  const updated = await repository.update(orderId, {
    status: 'COMPLETED',
    adminApprovedAt: new Date(),
  });

  // Listing stays occupied — already set false at SLOT_CONFIRMED, re-asserted
  // here because the self-install path never passes through that step.
  await setListingAvailability(order.listingId, false);

  const notifications: Promise<unknown>[] = [
    notifyUser(order.advertiserId, 'Order completed', 'Your order has been approved.', orderId),
  ];
  if (order.listing.publisher?.userId) {
    notifications.push(
      notifyUser(
        order.listing.publisher.userId,
        'Order completed',
        'Installation approved.',
        orderId,
      ),
    );
  }
  notifications.push(
    notifyAgent(order.agentId, 'Order approved', 'Well done! Order has been approved.', orderId),
  );
  Promise.all(notifications).catch(() => {});

  return updated;
}

export async function cancelOrder(orderId: string, reason?: string) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'COMPLETED') throw new Error('ALREADY_COMPLETED');

  const updated = await repository.update(orderId, { status: 'CANCELLED', notes: reason });

  // Free the listing so it can be booked again.
  await setListingAvailability(order.listingId, true);

  return updated;
}

/** Ends a completed campaign early, freeing the listing. */
export async function endCampaign(orderId: string) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'COMPLETED') throw new Error('WRONG_STATUS');

  await setListingAvailability(order.listingId, true);

  return repository.update(orderId, { endDate: new Date() });
}
