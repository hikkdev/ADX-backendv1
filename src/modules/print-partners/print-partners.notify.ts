import { logger } from '../../shared/logging';
import { notify, type NotifyOptions } from '../notifications';
import { notifyAdmins, shortId } from '../orders';

/**
 * Lot H: what the floor tells people. Every notice goes through `notify` —
 * the in-app row on the account, plus the push the event's template names
 * (no SMS kind is registered for print events yet; the owner's later
 * round). A notice that cannot be raised is logged and never fails the
 * move that raised it: a job that went READY has gone READY whether or not
 * the agent's phone heard about it.
 *
 * One function per event, each naming its event as a literal, so the
 * events registry test can read every call.
 */

export const orderRef = (orderId: string) => shortId(orderId);

const inApp = (title: string, message: string, orderId: string): NotifyOptions => ({
  type: 'ORDER',
  inApp: { type: 'ORDER', title, message, relatedId: orderId, relatedType: 'ORDER' },
});

const swallow = (event: string, userId: string) => (err: unknown) =>
  logger.warn('Print partner notice not raised', { event, userId, err });

/** To every partner invited on a request. */
export async function tellQuoteRequested(
  userId: string,
  order: { orderId: string; summary: string; deadline: Date; city: string | null },
): Promise<void> {
  const ref = orderRef(order.orderId);
  const deadline = order.deadline.toISOString();
  await notify(
    'PRINT_QUOTE_REQUESTED',
    userId,
    { orderRef: ref, summary: order.summary, deadline, city: order.city },
    inApp('Quote requested', `${order.summary} Quote for order ${ref} by ${deadline}.`, order.orderId),
  ).catch(swallow('PRINT_QUOTE_REQUESTED', userId));
}

/** The nightly re-invite, and a decline that reopened the request. */
export async function tellQuoteReopened(userId: string, order: { orderId: string; deadline: Date }): Promise<void> {
  const ref = orderRef(order.orderId);
  const deadline = order.deadline.toISOString();
  await notify(
    'PRINT_QUOTE_REQUEST_REOPENED',
    userId,
    { orderRef: ref, deadline },
    inApp('Quote still wanted', `The print for order ${ref} is open for quotes again until ${deadline}.`, order.orderId),
  ).catch(swallow('PRINT_QUOTE_REQUEST_REOPENED', userId));
}

/** G13-B: every invited partner, when ops cancel the request. */
export async function tellQuoteCancelled(userId: string, order: { orderId: string; reason: string }): Promise<void> {
  const ref = orderRef(order.orderId);
  await notify(
    'PRINT_QUOTE_REQUEST_CANCELLED',
    userId,
    { orderRef: ref, reason: order.reason },
    inApp('Quote request cancelled', `ADX withdrew the request for quotes on order ${ref}: ${order.reason}`, order.orderId),
  ).catch(swallow('PRINT_QUOTE_REQUEST_CANCELLED', userId));
}

/** The winning partner — at award, or when the desk opened a job by hand. */
export async function tellJobAssigned(userId: string, job: { orderId: string; amount: string | null; partnerName: string }): Promise<void> {
  const ref = orderRef(job.orderId);
  const amount = job.amount ?? '—';
  await notify(
    'PRINT_JOB_ASSIGNED',
    userId,
    { orderRef: ref, amount, partnerName: job.partnerName },
    inApp('Print job assigned', `Order ${ref} is yours to print at ₹${amount}. Accept the job to start.`, job.orderId),
  ).catch(swallow('PRINT_JOB_ASSIGNED', userId));
}

/** The partners whose quote was not awarded. */
export async function tellQuoteRejected(userId: string, orderId: string): Promise<void> {
  const ref = orderRef(orderId);
  await notify(
    'PRINT_QUOTE_REJECTED',
    userId,
    { orderRef: ref },
    inApp('Quote not selected', `Another partner was awarded the print for order ${ref}.`, orderId),
  ).catch(swallow('PRINT_QUOTE_REJECTED', userId));
}

/** The agent who collects, when the partner marks the material ready. */
export async function tellJobReady(userId: string, job: { orderId: string; partnerName: string; address: string | null }): Promise<void> {
  const ref = orderRef(job.orderId);
  const address = job.address ?? 'the print shop';
  await notify(
    'PRINT_JOB_READY',
    userId,
    { orderRef: ref, partnerName: job.partnerName, address },
    inApp('Prints ready for pickup', `${job.partnerName} has the material for order ${ref} ready at ${address}.`, job.orderId),
  ).catch(swallow('PRINT_JOB_READY', userId));
}

/** Ops, in-app — the desk's queue is the console, so a row is enough. */
export async function tellOps(title: string, message: string, orderId: string): Promise<void> {
  try {
    await notifyAdmins(title, message, orderId);
  } catch (err) {
    logger.warn('Ops notice not raised', { title, orderId, err });
  }
}
