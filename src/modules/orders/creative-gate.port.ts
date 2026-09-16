/**
 * Lot D (Q120): whether an order's artwork is approved, without importing the
 * module that decides.
 *
 * `campaigns` raises orders — a booked spot becomes one at authorisation —
 * so `orders` importing `campaigns` back would close a cycle. The one
 * question the print step asks is declared here as a port and bootstrap
 * fills it with `campaigns.creativeGateForOrder`: is every creative that
 * hangs on this order's spot (or on the whole campaign) APPROVED?
 *
 * Unregistered, the port answers "approved" — an order with no campaign
 * behind it has no artwork to gate, and a deployment that forgot the wiring
 * must not stop every print in the country. The verifier's route snapshot
 * and bootstrap test are what catch a missing registration.
 */

export type CreativeGateVerdict = {
  approved: boolean;
  /** Why not, in words for the 409 — which creatives, and what state they are in. */
  reason: string | null;
};

export type CreativeGatePort = {
  artworkApprovedFor(orderId: string): Promise<CreativeGateVerdict>;
};

const OPEN: CreativeGatePort = {
  artworkApprovedFor: async () => ({ approved: true, reason: null }),
};

let registered: CreativeGatePort = OPEN;

export function registerCreativeGatePort(port: CreativeGatePort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetCreativeGatePort(): void {
  registered = OPEN;
}

export function creativeGatePort(): CreativeGatePort {
  return registered;
}
