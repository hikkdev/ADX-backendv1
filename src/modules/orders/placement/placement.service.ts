import { getListingWithPublisher, setListingAvailability } from '../../listings';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyUser } from '../orders.notify';
import type { NewOrder } from '../orders.repository';

/**
 * Places an order against a listing.
 *
 * An occupied listing whose previous campaign has already ended is freed and
 * allowed through — otherwise a finished campaign would block the slot forever
 * because nothing else resets `availableNow`.
 */
export async function placeOrder(data: NewOrder) {
  const listing = await getListingWithPublisher(data.listingId);
  if (!listing) throw new Error('LISTING_NOT_FOUND');
  if (listing.status !== 'ACTIVE') throw new Error('LISTING_NOT_ACTIVE');

  if (!listing.availableNow) {
    const completedOrder = await repository.findCompletedExpiredForListing(data.listingId);
    if (completedOrder) {
      await setListingAvailability(data.listingId, true);
    } else {
      throw new Error('LISTING_NOT_AVAILABLE');
    }
  }

  const order = await repository.create(data);

  // Fire-and-forget: a notification failure must not fail the order.
  if (listing.publisher?.userId) {
    notifyUser(
      listing.publisher.userId,
      'New order request',
      `A new order has been placed for your listing "${listing.title}".`,
      order.id,
    ).catch(() => {});
  }

  return order;
}
