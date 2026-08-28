import { ApiError } from '../../../shared/errors';
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
  if (order.listing.qrToken !== coords.qrToken) {
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

  return { checkIn, order };
}

/**
 * Live agent position while travelling to a site.
 *
 * Deliberately does no ownership check and no existence check — it is a
 * high-frequency ping from the agent app, and the route guard is the only gate.
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
  return {
    latitude: order.agentLatitude,
    longitude: order.agentLongitude,
    updatedAt: order.agentLocationUpdatedAt,
  };
}
