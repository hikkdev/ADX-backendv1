import { getListingWithPublisher, setListingAvailability, windowFor } from '../../listings';
import { isFeatureEnabled } from '../../feature-flags';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyUser, shortId } from '../orders.notify';
import { meetingPointFor } from '../scheduling/scheduling.service';
import type { PlacementInput } from '../orders.repository';
import type { ListingWithPublisher } from '../../listings';

/**
 * Lot D (Q6/Q105): whether this listing accepts the order on the publisher's
 * behalf, and where the agent then collects the material.
 *
 * Three things have to hold, and each is re-asked here rather than trusted
 * from the moment the publisher opted in: the spot says so, ops still have
 * the `instant-booking` flag on for this publisher, and the publisher's
 * record still yields a meeting place. Any of them failing means the order
 * simply waits for the publisher, as every order did before the lot — a
 * quiet fallback, never a refused booking.
 */
async function instantAcceptance(listing: ListingWithPublisher): Promise<{ at: Date; meetingPlace: string } | null> {
  if (!listing.instantBooking || !listing.publisherId) return null;
  if (!(await isFeatureEnabled('instant-booking', listing.publisherId))) return null;
  try {
    return { at: new Date(), meetingPlace: meetingPointFor(listing.publisher) };
  } catch {
    return null;
  }
}

/**
 * Places an order against a listing.
 *
 * Lot G (Q116/136): the spot's slots are counted over the order's flight
 * (today, when it has none) and the order is refused only when fewer are
 * left than it takes — a six-slot screen takes six overlapping orders, a
 * static wall one, and (G10) a campaign spot of three takes three. The
 * count is `listings`' rule, with the campaign the order is raised for left
 * out so its own reservation never blocks it.
 *
 * G10: the count and the insert run inside `placeUnderListingLock` — one
 * transaction holding a per-listing advisory lock — so two placements racing
 * for the last slot are serialised and the second reads the first's row.
 * The instant-acceptance decision is made before the lock (it reads the
 * flag, not the slots); the availability flag is squared inside it.
 *
 * `availableNow` stays a switch on a static wall: an occupied listing whose
 * previous campaign has already ended is freed and allowed through —
 * otherwise a finished campaign would block the slot forever because nothing
 * else resets the flag. On a loop the flag is derived ("full today"), so
 * when the count says there is room the flag is simply set right.
 */
export async function placeOrder(input: PlacementInput) {
  const { forCampaignId, quantity = 1, ...data } = input;
  const listing = await getListingWithPublisher(data.listingId);
  if (!listing) throw new Error('LISTING_NOT_FOUND');
  if (listing.status !== 'ACTIVE') throw new Error('LISTING_NOT_ACTIVE');

  const slotsTotal = listing.slotsTotal ?? 1;
  const window = windowFor(data.startDate, data.endDate);
  const options = forCampaignId ? { excludeCampaignId: forCampaignId } : {};
  const accepted = await instantAcceptance(listing);

  const order = await repository.placeUnderListingLock(listing.id, async (locked) => {
    const held = await locked.slotsHeld(window, options);
    if (held + Math.max(1, quantity) > slotsTotal) throw new Error('LISTING_NOT_AVAILABLE');

    if (!listing.availableNow) {
      const completedOrder = slotsTotal > 1 ? null : await repository.findCompletedExpiredForListing(data.listingId);
      if (slotsTotal > 1 || completedOrder) {
        await setListingAvailability(data.listingId, true);
      } else {
        throw new Error('LISTING_NOT_AVAILABLE');
      }
    }

    return accepted ? locked.create(data, accepted) : locked.create(data);
  });

  // Fire-and-forget: a notification failure must not fail the order.
  if (accepted) {
    // The same fan-out `publisherAcceptOrder` does, plus the publisher, who
    // did not tap and should know the order is already on its way to print.
    // Who installs is still theirs to answer (`choose-fulfilment`).
    Promise.all([
      listing.publisher?.userId
        ? notifyUser(
            listing.publisher.userId,
            'Booking accepted for you',
            `"${listing.title}" accepted a booking automatically. Tell us who installs when you are ready.`,
            order.id,
          )
        : Promise.resolve(),
      notifyUser(data.advertiserId, 'Order accepted', 'The publisher accepted your order.', order.id),
      notifyAdmins('Order ready for print', `Order ${shortId(order.id)} accepted by instant booking.`, order.id),
    ]).catch(() => {});
    return order;
  }

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
