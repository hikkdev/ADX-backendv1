import { ApiError } from '../../shared/errors';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import type { ListingPatch, NewListing } from './listings.repository';

export async function createListing(data: NewListing) {
  return repository.create(data);
}

export async function getListingsForPublisher(publisherId: string) {
  return repository.findForPublisher(publisherId);
}

export async function getAllListings() {
  return repository.findAllForAdmin();
}

export async function updateListing(listingId: string, data: ListingPatch) {
  return repository.update(listingId, data);
}

/**
 * Publishing is a state transition, not a patch: only DRAFT and PENDING_REVIEW
 * can be published, and doing so stamps `publishedAt`. That is why `status` is
 * absent from the update schema.
 */
export async function publishListing(listingId: string) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (listing.status !== 'DRAFT' && listing.status !== 'PENDING_REVIEW') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Listing must be in DRAFT or PENDING_REVIEW state to publish',
    );
  }
  return repository.publish(listingId);
}

export async function getSimilarListings(listingId: string) {
  const listing = await repository.findById(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  return repository.findSimilar(listing);
}

/**
 * An explicit `agentId` on create is ADMIN-only. Callers without one fall back
 * to their own agent profile, resolved by the controller.
 */
export async function assertAgentAssignable(agentId: string, isAdmin: boolean): Promise<string> {
  if (!isAdmin) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only admins can create a listing on behalf of another agent',
    );
  }
  if (!(await repository.agentExists(agentId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  }
  return agentId;
}

/**
 * Reads and writes the `orders` module needs on a listing.
 *
 * Order progression flips `availableNow` — occupied when a slot is confirmed,
 * free again on cancellation or campaign end. Exposed here so orders never
 * writes to the Listing table itself.
 */
export async function getListingWithPublisher(listingId: string) {
  return repository.findWithPublisher(listingId);
}

export async function setListingAvailability(listingId: string, availableNow: boolean) {
  await repository.setAvailability(listingId, availableNow);
}

/** Plain listing lookup, used by `order-milestones` to resolve a plan. */
export async function getListingById(listingId: string) {
  return repository.findById(listingId);
}
