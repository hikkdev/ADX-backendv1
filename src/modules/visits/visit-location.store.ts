import { redis } from '../../shared/cache';
import { logger } from '../../shared/logging';

/**
 * G12-B: the agent's live position on the way to a field visit.
 *
 * The order lane keeps this on the order row (`agentLatitude`,
 * `agentLongitude`, `agentLocationUpdatedAt`) and a milestone visit lands on
 * its order. A `FieldVisit` has neither a column nor an order, and the
 * schema is not this module's to extend, so the ping goes to Redis — one
 * key per visit, the same three fields, expiring on its own. A position is
 * news for the day of the visit, not a record: nothing settles on it, and a
 * store that forgets is the right store for it. Redis rather than a process
 * map because the phone's next ping and the console's read may land on
 * different instances.
 *
 * Neither the write nor the read may fail a request: a Redis blink drops
 * one ping (the next one is seconds away) and reads as "no position yet".
 */

/** The shape `GET /orders/:id/agent-location` answers, so a visit reads the same way an order does. */
export type VisitLocation = { latitude: number; longitude: number; updatedAt: string };

/** A day: the longest a visit's position stays interesting after the last ping. */
export const VISIT_LOCATION_TTL_SECONDS = 24 * 60 * 60;

export const visitLocationKey = (visitId: string): string => `visits:location:${visitId}`;

export async function setVisitLocation(visitId: string, coords: { latitude: number; longitude: number }, at: Date): Promise<void> {
  const value: VisitLocation = { latitude: coords.latitude, longitude: coords.longitude, updatedAt: at.toISOString() };
  try {
    await redis.set(visitLocationKey(visitId), JSON.stringify(value), 'EX', VISIT_LOCATION_TTL_SECONDS);
  } catch (err) {
    logger.warn('visit location write failed', { visitId, err: err instanceof Error ? err.message : String(err) });
  }
}

export async function getVisitLocation(visitId: string): Promise<VisitLocation | null> {
  try {
    const raw = await redis.get(visitLocationKey(visitId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { latitude, longitude, updatedAt } = parsed as Record<string, unknown>;
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || typeof updatedAt !== 'string') return null;
    return { latitude, longitude, updatedAt };
  } catch (err) {
    logger.warn('visit location read failed', { visitId, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
