import { ApiError } from '../../shared/errors';
import { toListPage, type ListPage } from '../../shared/pagination';
import { belowFloorFlags } from '../rate-cards';
import { prismaPublishersRepository as repository } from './prisma-publishers.repository';
import type { MyListing } from './publishers.repository';
import type { MyListingsQuery } from './publishers.schema';

/**
 * DR 06's Publisher · Listings list — the publisher's own inventory.
 *
 * Lives here rather than in `listings` for the same reason the dashboard does:
 * the screen's chips are Available / Occupied / Inactive, and occupancy is a
 * live order on the spot, which this module already reads through the
 * `listing.orders` relation with `OCCUPYING_ORDER_STATUSES`.
 *
 * The publisher is resolved from the session, never from the URL. There is a
 * `/publishers/:publisherId/listings` next door and it is the agent's: its
 * guard asks whether the caller is the onboarding agent, which is why a
 * publisher asking for their own spots through it gets a 403.
 */
export async function getMyListings(
  userId: string,
  query: MyListingsQuery,
): Promise<ListPage<MyListing & { belowFloor: boolean }>> {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) {
    throw new ApiError(403, 'FORBIDDEN', 'You have no publisher account, so there are no spots to list');
  }
  const { items, total, counts } = await repository.findMyListings(publisher.id, query);
  return toListPage(await stampBelowFloor(items), total, counts, query);
}

/**
 * E11-1: the rate-card chip on every row, as `GET /listings` has carried it
 * since Lot E — true when the rate sits under the floor of the card in force,
 * whatever case stands on it. One read through rate-cards for the page;
 * nothing asked over an empty page.
 */
export async function stampBelowFloor<T extends { id: string }>(rows: T[]): Promise<(T & { belowFloor: boolean })[]> {
  const flags = rows.length ? await belowFloorFlags(rows.map((row) => row.id)) : {};
  return rows.map((row) => ({ ...row, belowFloor: flags[row.id] ?? false }));
}
