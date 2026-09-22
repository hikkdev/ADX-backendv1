import { pointInRing } from './feeds/feed.port';

/**
 * LH5 (the Lead Hunt, 22 Sep 2026): the map's arithmetic — the viewport,
 * the clusters above a zoom, the polygons (no PostGIS: a bounding box the
 * index can take, then the ring in code), the claim rules (D3), the
 * priority top-up under its cap (D7). Pure; the service reads the rows.
 */

export type BBox = { south: number; west: number; north: number; east: number };

/** `?bbox=south,west,north,east` — a viewport, refused when it is not one or spans the world. */
export function parseBBox(text: string | undefined): BBox | null {
  if (!text) return null;
  const parts = text.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [south, west, north, east] = parts as [number, number, number, number];
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) return null;
  return { south, west, north, east };
}

/** GeoJSON's Polygon coordinates: an outer ring of [lng, lat], closed or not. */
export type Ring = [number, number][];

export function parseRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 500) return null;
  const ring: Ring = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    ring.push([lng, lat]);
  }
  // A closed ring repeats its first point; either form is taken.
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (ring.length > 3 && first[0] === last[0] && first[1] === last[1]) ring.pop();
  return ring.length >= 3 ? ring : null;
}

export function bboxOfRing(ring: Ring): BBox {
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

export function inBBox(point: { latitude: number; longitude: number }, box: BBox): boolean {
  return point.latitude >= box.south && point.latitude <= box.north && point.longitude >= box.west && point.longitude <= box.east;
}

export function inRing(point: { latitude: number; longitude: number }, ring: Ring): boolean {
  return inBBox(point, bboxOfRing(ring)) && pointInRing(point, ring);
}

/** Square kilometres of a viewport — what decides clusters vs pins. */
export function bboxAreaKm2(box: BBox): number {
  const latKm = (box.north - box.south) * 111;
  const midLat = ((box.north + box.south) / 2) * (Math.PI / 180);
  const lngKm = (box.east - box.west) * 111 * Math.cos(midLat);
  return Math.max(0, latKm * lngKm);
}

/** Above this many square kilometres the map draws clusters, not pins. */
export const CLUSTER_ABOVE_KM2 = 60;
/** How many pins one viewport may carry — the same cap browse uses. */
export const PIN_CAP = 500;

/** The grid cell a point falls in at a given cell size in degrees — the cluster key. */
export function cellOf(point: { latitude: number; longitude: number }, cellDeg: number): string {
  return `${Math.floor(point.latitude / cellDeg)}:${Math.floor(point.longitude / cellDeg)}`;
}

/** The cell size for a viewport: about a fifteenth of its shorter side, never under 500 m. */
export function cellSizeFor(box: BBox): number {
  const shorter = Math.min(box.north - box.south, box.east - box.west);
  return Math.max(0.0045, shorter / 15);
}

export type ClusterOut = { latitude: number; longitude: number; count: number; hot: number; warm: number; cold: number; label: string };

export function clusterPoints<T extends { latitude: number; longitude: number; temperature?: string | null }>(rows: T[], box: BBox): ClusterOut[] {
  const cell = cellSizeFor(box);
  const cells = new Map<string, { lat: number; lng: number; count: number; hot: number; warm: number; cold: number }>();
  for (const row of rows) {
    const key = cellOf(row, cell);
    const current = cells.get(key) ?? { lat: 0, lng: 0, count: 0, hot: 0, warm: 0, cold: 0 };
    current.lat += row.latitude;
    current.lng += row.longitude;
    current.count += 1;
    if (row.temperature === 'HOT') current.hot += 1;
    else if (row.temperature === 'WARM') current.warm += 1;
    else current.cold += 1;
    cells.set(key, current);
  }
  return [...cells.values()]
    .map((c) => ({ latitude: c.lat / c.count, longitude: c.lng / c.count, count: c.count, hot: c.hot, warm: c.warm, cold: c.cold, label: `${c.count} ${c.count === 1 ? 'LEAD' : 'LEADS'}` }))
    .sort((a, b) => b.count - a.count);
}

/* ── claims (D3) ───────────────────────────────────────────────────────── */

export type ClaimVerdict = { ok: true } | { ok: false; code: 'CLAIMED_BY_OTHER' | 'CLAIM_CAP' | 'COOLDOWN' | 'CLOSED'; reason: string; until?: Date };

export function claimVerdict(input: {
  lead: { stage: string; claimedByAgentId: string | null; claimExpiresAt: Date | null; assignedAgentId: string | null };
  agentId: string;
  tier: string;
  open: number;
  caps: Record<string, number | null>;
  /** When this agent's last claim on the lead lapsed, if it did. */
  lastLapsedAt: Date | null;
  cooldownDays: number;
  now: Date;
}): ClaimVerdict {
  const { lead, agentId, now } = input;
  if (['CONVERTED', 'ONBOARDING', 'ACTIVATED', 'RETAINED', 'LOST'].includes(lead.stage)) return { ok: false, code: 'CLOSED', reason: 'That lead is closed' };
  const held = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now ? lead.claimedByAgentId : lead.assignedAgentId;
  if (held && held !== agentId) return { ok: false, code: 'CLAIMED_BY_OTHER', reason: 'Another agent holds this lead', until: lead.claimExpiresAt ?? undefined };
  if (input.lastLapsedAt) {
    const until = new Date(input.lastLapsedAt.getTime() + input.cooldownDays * 24 * 60 * 60 * 1000);
    if (until > now && held !== agentId) return { ok: false, code: 'COOLDOWN', reason: `You let this one lapse; it is yours again from ${until.toISOString().slice(0, 10)}`, until };
  }
  const cap = input.caps[input.tier];
  if (cap !== null && cap !== undefined && held !== agentId && input.open >= cap) return { ok: false, code: 'CLAIM_CAP', reason: `Your ${input.tier.toLowerCase()} tier holds ${cap} leads at a time — work one to a close, or release one` };
  return { ok: true };
}

/* ── priority zones (D7) ───────────────────────────────────────────────── */

export type ZoneRow = { id: string; name: string; side: string | null; ring: Ring | null; category: string | null; topUp: number; startsAt: Date; endsAt: Date; budgetCap: number | null; spent: number; isActive: boolean };

/** Whether a zone covers a lead right now — by its ring, its category, or both. */
export function zoneCovers(zone: ZoneRow, lead: { side: string; latitude: number | null; longitude: number | null; category: string | null }, now: Date): boolean {
  if (!zone.isActive || zone.startsAt > now || zone.endsAt < now) return false;
  if (zone.side && zone.side !== lead.side) return false;
  if (zone.ring) {
    if (lead.latitude === null || lead.longitude === null) return false;
    if (!inRing({ latitude: lead.latitude, longitude: lead.longitude }, zone.ring)) return false;
  }
  if (zone.category && zone.category.trim().toLowerCase() !== (lead.category ?? '').trim().toLowerCase()) return false;
  return Boolean(zone.ring || zone.category);
}

/** The top-up a zone may still pay, under its own cap and the platform's monthly cap. */
export function topUpAllowed(zone: ZoneRow, platformTopUp: number, monthlyCap: number, spentThisMonth: number): number {
  const zoneRoom = zone.budgetCap === null ? Number.POSITIVE_INFINITY : Math.max(0, zone.budgetCap - zone.spent);
  const monthRoom = Math.max(0, monthlyCap - spentThisMonth);
  return Math.max(0, Math.min(zone.topUp || platformTopUp, zoneRoom, monthRoom));
}
