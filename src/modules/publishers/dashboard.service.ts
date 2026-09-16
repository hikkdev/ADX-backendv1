import { ApiError } from '../../shared/errors';
import { prismaPublishersRepository as repository } from './prisma-publishers.repository';
import type { DashboardListing } from './publishers.repository';

/**
 * DR 01's publisher home — "Good Morning, Ravi · Your listing performance
 * today", the occupancy gauge, and the map of their spots.
 *
 * Occupancy is the one figure the frame asks for, and it is computed rather
 * than stored: of the spots that are live, how many have a booking the
 * publisher accepted whose flight covers today. A publisher with no live
 * spot has no rate — the gauge says so instead of printing 0%.
 */

export type PublisherDashboard = {
  name: string;
  /** "Good morning" / "Good afternoon" / "Good evening", by the Indian clock. */
  greeting: string;
  occupancy: {
    /** 0–100, or null while nothing is live. */
    rate: number | null;
    occupied: number;
    live: number;
  };
  /** Bookings waiting for the publisher's answer. */
  awaiting: number;
  listings: DashboardListing[];
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function greetingFor(now: Date): string {
  const hour = new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function occupancyOf(listings: DashboardListing[]): PublisherDashboard['occupancy'] {
  const live = listings.filter((listing) => listing.status === 'ACTIVE');
  const occupied = live.filter((listing) => listing.occupied).length;
  return {
    rate: live.length === 0 ? null : Math.round((occupied / live.length) * 100),
    occupied,
    live: live.length,
  };
}

export async function getMyDashboard(userId: string, now = new Date()): Promise<PublisherDashboard> {
  const publisher = await repository.findByUserId(userId);
  if (!publisher) {
    throw new ApiError(404, 'NOT_FOUND', 'Publisher profile not found. Complete registration first.');
  }
  const { listings, awaiting } = await repository.findDashboard(publisher.id, now);
  return {
    name: publisher.name,
    greeting: greetingFor(now),
    occupancy: occupancyOf(listings),
    awaiting,
    listings,
  };
}
