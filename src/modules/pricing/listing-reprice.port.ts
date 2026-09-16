import { ApiError } from '../../shared/errors';

/**
 * Lot E (Q125): what a BINDING factor needs from the modules above it,
 * without importing them.
 *
 * `listings` imports this module to classify a spot, and `rate-cards` sits
 * beside it as the gate `listings` runs at publish — so pricing reaching
 * either of them back would close a cycle. The two things a binding apply
 * has to do outside its own tables are declared here and bootstrap fills
 * them: write the new rate through `listings.updateListing` (which stamps
 * the surge provenance and keeps the unit pair honest), and raise a price
 * case through `rate-cards` when the move is bigger than the cap allows.
 *
 * Unregistered, a binding apply refuses rather than pretending: an ADVISORY
 * apply never reaches this port, so a deployment that forgot the wiring
 * still records proposals and only loses the automatic reprice — loudly.
 */

export type ListingRepricePort = {
  /** Writes `ratePerDay` on the listing as ADX's own decision. */
  reprice(input: { listingId: string; ratePerDay: string; actorUserId: string }): Promise<void>;
  /** Raises (or returns the live) PriceApproval for a rate ADX proposes but may not write. */
  raisePriceCase(input: {
    listingId: string;
    requestedRatePerDay: string;
    requestedById: string;
    reason: string;
  }): Promise<{ id: string }>;
};

const UNWIRED: ListingRepricePort = {
  reprice: async () => {
    throw new ApiError(
      503,
      'NOT_IMPLEMENTED',
      'Binding factors are not wired to the listing write path on this deployment.'
    );
  },
  raisePriceCase: async () => {
    throw new ApiError(
      503,
      'NOT_IMPLEMENTED',
      'Binding factors are not wired to the price-case desk on this deployment.'
    );
  },
};

let registered: ListingRepricePort = UNWIRED;

export function registerListingRepricePort(port: ListingRepricePort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetListingRepricePort(): void {
  registered = UNWIRED;
}

export function listingRepricePort(): ListingRepricePort {
  return registered;
}
