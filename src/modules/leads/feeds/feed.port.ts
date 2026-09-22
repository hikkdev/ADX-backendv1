/**
 * LH3 (the Lead Hunt, 22 Sep 2026): the directory feed port — decision D4.
 *
 * One vocabulary for every directory: ops names a category and a city (or
 * draws a polygon) for a side, the adapter answers candidate rows, and the
 * importer takes it from there (geocoding, the phone and name-city dedup,
 * the EXISTING_ACCOUNT refusal). Google Places is live behind the maps
 * seam's server key; the others answer NOT_CONFIGURED until Settings ›
 * Integrations carries their credentials and the source row carries the
 * terms confirmation.
 */

export type FeedSide = 'PUBLISHER' | 'ADVERTISER';

export type FeedSearch = {
  side: FeedSide;
  category: string;
  city?: string | undefined;
  /** A ring of [longitude, latitude] pairs (GeoJSON order), when the run was drawn. */
  polygon?: [number, number][] | undefined;
  limit: number;
};

/** One business a directory answered, in the importer's own column names. */
export type FeedCandidate = {
  /** `<feedKey>:<provider id>` — the idempotence key on the lead. */
  externalKey: string;
  businessName: string;
  category: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  locality?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** What the provider said beyond the columns — kept on the report, never on the lead. */
  extra?: Record<string, unknown>;
};

export type FeedReadiness = { ok: true } | { ok: false; reason: string };

export interface LeadFeed {
  /** The `LeadSource.key` this adapter serves. */
  readonly key: string;
  readonly label: string;
  /** What the credential card asks for, in one sentence. */
  readonly needs: string;
  /** Whether the adapter can be called now — credentials present (the terms are the service's check). */
  configured(): Promise<FeedReadiness>;
  search(input: FeedSearch): Promise<FeedCandidate[]>;
}

/** The bounding box of a polygon ring — the coarse cut a directory can take. */
export function bboxOf(ring: [number, number][]): { south: number; west: number; north: number; east: number } | null {
  if (ring.length < 3) return null;
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const [lng, lat] of ring) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }
  return { south, west, north, east };
}

/** Ray casting: whether a point sits inside a polygon ring (GeoJSON [lng, lat] order). */
export function pointInRing(point: { latitude: number; longitude: number }, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > point.latitude !== yj > point.latitude && point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
