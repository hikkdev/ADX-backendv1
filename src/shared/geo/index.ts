/**
 * Distance on the ground.
 *
 * Two modules need this now — the comparables engine, which asks what is within
 * 200 m of a spot, and campaign targeting, which asks what is within a radius an
 * advertiser drew on a map. One implementation, because two would eventually
 * disagree about the same pair of coordinates.
 */

const EARTH_RADIUS_M = 6_371_000;
const METRES_PER_DEGREE_LAT = (2 * Math.PI * EARTH_RADIUS_M) / 360;

/** The bounding box over-selects by 1%, so the exact radius never under-selects. */
const BOX_SAFETY = 1.01;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance. Exact enough at 200 m that the model is irrelevant. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Bounding box for the SQL prefilter.
 *
 * Deliberately generous — it over-selects and the caller narrows to the exact
 * radius afterwards. A box that under-selects would silently drop rows, which is
 * the one failure mode that never announces itself.
 */
export function boundingBox(
  lat: number,
  radiusMeters: number
): { latDelta: number; lngDelta: number } {
  const reach = radiusMeters * BOX_SAFETY;
  const latDelta = reach / METRES_PER_DEGREE_LAT;
  // cos() collapses toward the poles; the floor keeps the box finite there
  // rather than dividing by something indistinguishable from zero.
  const cosLat = Math.max(Math.cos(toRad(lat)), 0.01);
  return { latDelta, lngDelta: reach / (METRES_PER_DEGREE_LAT * cosLat) };
}
