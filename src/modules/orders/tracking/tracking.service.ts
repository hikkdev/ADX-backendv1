import { ApiError } from '../../../shared/errors';
import { getPlatformSettings } from '../../app-config';
import { isSignedCodeFor } from '../../qr';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance in metres. */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Agent check-in at the site.
 *
 * The QR token must match the listing's own — proof the agent is at the right
 * place — and the distance from the listing's coordinates is recorded rather
 * than enforced, so a check-in is never blocked by a bad GPS fix. A listing
 * with no coordinates yields distance 0 by design.
 *
 * The scan is also recorded on the site verification. It used to write only the
 * CheckIn row, which left `SiteVerification.qrScanned` false for ever — and
 * that is the flag the submit gate reads for its CHECK_IN requirement. So the
 * gate could never open: an agent could check in, photograph the site, install
 * the advertisement, photograph that, and still be told the evidence was
 * incomplete, with nothing on any screen to say which part was missing.
 *
 * Throws ApiError directly rather than sentinels: this path never went through
 * the sentinel mapper, and its INVALID_QR code exists nowhere else.
 */
export async function agentCheckIn(
  orderId: string,
  agentProfileId: string,
  coords: { latitude: number; longitude: number; qrToken: string },
) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.agentId !== agentProfileId) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this order');
  }
  // The spot's own token is what the app holds; a signed SITE or ORDER code
  // that resolves to this listing or order is the same proof by another road.
  if (
    order.listing.qrToken !== coords.qrToken &&
    !(await isSignedCodeFor(coords.qrToken, { listingId: order.listingId, orderId: order.id }))
  ) {
    throw new ApiError(400, 'INVALID_QR', 'QR code does not match this listing');
  }

  const distanceM = haversineMetres(
    coords.latitude,
    coords.longitude,
    order.listing.latitude ?? coords.latitude,
    order.listing.longitude ?? coords.longitude,
  );

  const checkIn = await repository.upsertCheckIn(orderId, {
    latitude: coords.latitude,
    longitude: coords.longitude,
    distanceM,
  });

  // Reached only once the token has matched above, so this records a scan that
  // actually happened rather than an attempt.
  await repository.upsertVerification(orderId, { qrScanned: true });

  return { checkIn, order };
}

/**
 * Lot H (the G12 verifier's gap): `POST /orders/:id/update-location` writes
 * only for the order's own agent — 403 for anyone else, the rule the
 * milestone route already applies. One summary read per ping; the write
 * itself is `updateAgentLocation` below, which `order-milestones` still
 * calls with its own ownership check done.
 */
export async function agentUpdateLocation(
  orderId: string,
  agentProfileId: string,
  coords: { latitude: number; longitude: number },
): Promise<void> {
  const order = await repository.findSummary(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.agentId !== agentProfileId) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this order');
  }
  await updateAgentLocation(orderId, coords);
}

/**
 * Live agent position while travelling to a site.
 *
 * Does no ownership check and no existence check of its own: the route
 * goes through `agentUpdateLocation` above, and `order-milestones` checks
 * the visit is the agent's before calling this.
 */
export async function updateAgentLocation(
  orderId: string,
  coords: { latitude: number; longitude: number },
) {
  await repository.update(orderId, {
    agentLatitude: coords.latitude,
    agentLongitude: coords.longitude,
    agentLocationUpdatedAt: new Date(),
  });
}

export async function getAgentLocation(orderId: string) {
  const order = await repository.findAgentLocation(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  // LT-1: an ETA beside the position when the platform settings allow the
  // parties to see one — straight-line metres at a city drive, the same
  // floor the ops live map uses; null without a fix, a site, or the switch.
  const settings = await getPlatformSettings();
  const eta =
    settings.tracking.partiesSeeEta && order.agentLatitude !== null && order.agentLongitude !== null && order.listing.latitude !== null && order.listing.longitude !== null
      ? etaFrom({ latitude: order.agentLatitude, longitude: order.agentLongitude }, { latitude: order.listing.latitude, longitude: order.listing.longitude })
      : null;
  return {
    latitude: order.agentLatitude,
    longitude: order.agentLongitude,
    updatedAt: order.agentLocationUpdatedAt,
    eta,
  };
}

const ETA_FLOOR_MPS = 6;
function etaFrom(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): { minutes: number; distanceM: number } {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLng = rad(to.longitude - from.longitude);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLng / 2) ** 2;
  const metres = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
  return { minutes: Math.max(1, Math.round(metres / ETA_FLOOR_MPS / 60)), distanceM: Math.round(metres) };
}
