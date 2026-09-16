import { ApiError } from '../../shared/errors';

/**
 * Lot E (Q97): taking a listing off the market, without importing the module
 * that owns it.
 *
 * `listings` imports this module — the gate runs at publish — so reaching
 * back to unpublish would close a cycle. The one write a rejected
 * CARD_REVISION case needs is declared here and bootstrap fills it with
 * `listings.unpublishListing`, which audits the move and tells the publisher.
 *
 * Unregistered, the port refuses rather than pretending: a rejection that
 * silently left the listing live would be the exact state the case exists to
 * end, so a deployment that forgot the wiring hears about it on the first
 * rejection.
 */

export type ListingEnforcementPort = {
  unpublish(input: { listingId: string; reason: string; actorUserId: string }): Promise<void>;
};

const UNWIRED: ListingEnforcementPort = {
  unpublish: async () => {
    throw new ApiError(
      503,
      'NOT_IMPLEMENTED',
      'Rate-card enforcement is not wired to the listing module on this deployment.'
    );
  },
};

let registered: ListingEnforcementPort = UNWIRED;

export function registerListingEnforcementPort(port: ListingEnforcementPort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetListingEnforcementPort(): void {
  registered = UNWIRED;
}

export function listingEnforcementPort(): ListingEnforcementPort {
  return registered;
}
