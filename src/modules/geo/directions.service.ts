import { readThrough } from '../../shared/cache';
import { routeDirections, type Directions, type DirectionsMode, type GeoPoint } from '../../shared/maps';

/**
 * Q137: directions, once per opened job.
 *
 * A job screen asks for its route when it opens and draws the line; every
 * refresh of that screen would otherwise be another billable call for a
 * route that has not changed. So the answer is kept in Redis for fifteen
 * minutes under the pair rounded to four decimals (about eleven metres —
 * the jitter of a phone standing still), per mode. Two agents opening the
 * same job from the same corner share the answer; a refresh never reaches
 * the vendor. Redis being down means the vendor is asked — `readThrough`
 * logs and loads rather than failing the read.
 *
 * "No route" is cached too, as null: asking the vendor again in a minute
 * will not find one.
 */
export const DIRECTIONS_CACHE_TTL_S = 15 * 60;
const ROUND_TO = 4;

const round = (n: number): string => n.toFixed(ROUND_TO);

export function directionsCacheKey(from: GeoPoint, to: GeoPoint, mode: DirectionsMode): string {
  return `geo:directions:${mode}:${round(from.latitude)},${round(from.longitude)}>${round(to.latitude)},${round(to.longitude)}`;
}

export async function directionsBetween(from: GeoPoint, to: GeoPoint, mode: DirectionsMode): Promise<Directions | null> {
  return readThrough<Directions | null>(directionsCacheKey(from, to, mode), DIRECTIONS_CACHE_TTL_S, () =>
    routeDirections(from, to, mode),
  );
}
