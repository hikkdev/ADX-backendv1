import bcrypt from 'bcryptjs';
import { logger } from '../../../shared/logging';
import { money, type Decimal, type Money } from '../../../shared/money';
import { findAgentTier } from '../../agents';
import { setListingAvailability } from '../../listings';
import { installationFeeFor, recordIncentiveOnce } from '../../payouts';
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

/**
 * Lot B (Q102): the installation commission, recorded at sign-off.
 *
 * The figure is the accepted assignment's quote — what the sheet showed when
 * the agent took the job — and the resolver only when that offer carried
 * none. Recorded once per order (`recordIncentiveOnce`), PENDING_VERIFICATION
 * for finance to release like every other incentive. An order with no agent
 * (self-install) records nothing.
 *
 * Never fails the approval: the order is already COMPLETED by the time this
 * runs, and a retry would meet WRONG_STATUS. A failure is logged for ops to
 * record by hand through `POST /finance/incentives`.
 */
async function recordInstallationCommission(
  order: { id: string; agentId: string | null; agentFeeAmount: Decimal | null },
): Promise<{ id: string; amount: Money } | null> {
  if (!order.agentId) return null;
  try {
    const assignments = await repository.findAssignments(order.id);
    const accepted = assignments
      .filter((assignment) => assignment.status === 'ACCEPTED' && assignment.agentId === order.agentId)
      .sort((a, b) => b.assignedAt.getTime() - a.assignedAt.getTime())[0];
    const tier = (await findAgentTier(order.agentId)) ?? '*';
    const quoted = accepted?.quotedFee ?? null;
    const amount =
      quoted !== null && quoted !== undefined
        ? money(quoted as never)
        : await installationFeeFor(order, tier);
    const incentive = await recordIncentiveOnce({
      agentId: order.agentId,
      event: 'INSTALLATION',
      tier,
      orderId: order.id,
      amount,
      note: `Installation of order ${shortId(order.id)}`,
    });
    notifyAgent(
      order.agentId,
      'Commission recorded',
      `${money(incentive.amount as never)} for order ${shortId(order.id)} is recorded — ADX finance releases it.`,
      order.id,
    ).catch(() => {});
    return { id: incentive.id, amount: money(incentive.amount as never) };
  } catch (err) {
    logger.error('Installation commission was not recorded', { orderId: order.id, agentId: order.agentId, err });
    return null;
  }
}

/** Admin sign-off. Notifies all three parties, and records the agent's commission. */
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

  const incentive = await recordInstallationCommission(order);

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

  return { ...updated, incentive };
}

/**
 * Cancels. Lot D (Q51/Q90): who, when and why go on their own columns —
 * `cancelledAt`, `cancelledByUserId`, `cancellationReason` — where they used
 * to overwrite `notes`, which is the advertiser's brief and not ADX's.
 * `cancelledByUserId` is null for a cancellation the platform made on its
 * own (a suspension's STOP_OPEN_WORK).
 */
export async function cancelOrder(orderId: string, reason?: string, cancelledByUserId: string | null = null) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'COMPLETED') throw new Error('ALREADY_COMPLETED');

  const updated = await repository.update(orderId, {
    status: 'CANCELLED',
    cancelledAt: new Date(),
    cancelledByUserId,
    cancellationReason: reason ?? null,
  });

  // Free the listing so it can be booked again.
  await setListingAvailability(order.listingId, true);

  // Everyone the order reached is told; a notification failure never fails the cancel.
  const message = reason ? `Order ${shortId(orderId)} was cancelled. Reason: ${reason}` : `Order ${shortId(orderId)} was cancelled.`;
  const told: Promise<unknown>[] = [notifyUser(order.advertiserId, 'Order cancelled', message, orderId)];
  if (order.listing.publisher?.userId) told.push(notifyUser(order.listing.publisher.userId, 'Order cancelled', message, orderId));
  if (order.agentId) told.push(notifyAgent(order.agentId, 'Order cancelled', message, orderId));
  Promise.all(told).catch(() => {});

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
