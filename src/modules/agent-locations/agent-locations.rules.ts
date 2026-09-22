/**
 * LT-1 (live agent tracking, 22 Sep 2026): the arithmetic behind the live
 * map, pure so a test can pin each rule on numbers. Distances are
 * haversine metres; nothing here reads a clock or a store.
 */

export type LatLng = { latitude: number; longitude: number };

export type TrackingContextKind = 'ORDER' | 'MILESTONE' | 'FIELD_VISIT';

/** The last fix as Redis holds it — what one ping leaves behind. */
export type LastFix = LatLng & {
  agentId: string;
  /** ISO, the phone's clock where it gave one, else the server's. */
  at: string;
  accuracy: number | null;
  /** Metres per second. */
  speed: number | null;
  heading: number | null;
  context: { kind: TrackingContextKind; id: string; orderId: string | null; label: string; destination: LatLng | null; slotAt: string | null; arrivedAt: string | null } | null;
  /** When the position last moved more than STILL_RADIUS_M — the idle alert reads it. */
  movingAt: string;
  /** The first fix of the current trip, for the off-route corridor. */
  tripStart: LatLng | null;
};

export type AgentState = 'OFFLINE' | 'AVAILABLE' | 'TRAVELLING' | 'ON_SITE' | 'STILL';
export type AlertKind = 'IDLE' | 'LATE' | 'OFF_ROUTE' | 'OFFLINE';

export type TrackingRules = {
  geofenceRadiusM: number;
  idleAlertMin: number;
  lateGraceMin: number;
  offRouteKm: number;
  offlineAfterMin: number;
};

/** A fix closer than this to the last kept one, within THIN_SECONDS, is not written to the trail. */
export const THIN_METRES = 25;
export const THIN_SECONDS = 60;
/** The position has "moved" when it is further than this from where it last moved to. */
export const STILL_RADIUS_M = 50;
/** Below this the phone is standing; above it the ETA uses the reported speed. */
export const WALKING_MPS = 1;
/** The floor an ETA is computed at when the phone reports slower — a city drive. */
export const ETA_FLOOR_MPS = 6;

const R = 6371000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Whether a fix is worth a trail row, against the last one kept. */
export function worthKeeping(previous: { latitude: number; longitude: number; at: Date } | null, next: LatLng & { at: Date }): boolean {
  if (!previous) return true;
  if (distanceM(previous, next) >= THIN_METRES) return true;
  return next.at.getTime() - previous.at.getTime() >= THIN_SECONDS * 1000;
}

/** Distance from `p` to the segment `a`→`b`, in metres — on a flat local plane, which is what a city trip is. */
export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = 111320 * Math.cos(rad(p.latitude));
  const ky = 110540;
  const ax = (a.longitude - p.longitude) * kx;
  const ay = (a.latitude - p.latitude) * ky;
  const bx = (b.longitude - p.longitude) * kx;
  const by = (b.latitude - p.latitude) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(ax, ay);
  const t = Math.max(0, Math.min(1, (-(ax * dx) - ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Minutes to the destination at the reported speed (floored at a city drive), and the metres left. Null with no destination. */
export function etaTo(fix: LatLng & { speed: number | null }, destination: LatLng | null): { minutes: number; distanceM: number } | null {
  if (!destination) return null;
  const metres = distanceM(fix, destination);
  const mps = Math.max(fix.speed ?? 0, ETA_FLOOR_MPS);
  return { minutes: Math.max(1, Math.round(metres / mps / 60)), distanceM: Math.round(metres) };
}

export function isArrived(fix: LatLng, destination: LatLng | null, rules: Pick<TrackingRules, 'geofenceRadiusM'>): boolean {
  return destination !== null && distanceM(fix, destination) <= rules.geofenceRadiusM;
}

/** Where the agent is, read off the last fix and the clock. */
export function stateOf(fix: LastFix | null, now: Date, rules: Pick<TrackingRules, 'offlineAfterMin'>): AgentState {
  if (!fix) return 'OFFLINE';
  const ageMin = (now.getTime() - new Date(fix.at).getTime()) / 60000;
  if (ageMin > rules.offlineAfterMin) return 'OFFLINE';
  if (!fix.context) return 'AVAILABLE';
  if (fix.context.arrivedAt) return 'ON_SITE';
  const stillMin = (now.getTime() - new Date(fix.movingAt).getTime()) / 60000;
  const moving = (fix.speed ?? 0) >= WALKING_MPS || stillMin < 2;
  return moving ? 'TRAVELLING' : 'STILL';
}

export type Alert = { kind: AlertKind; since: string | null; detail: string };

/** The live map's flags for one agent — every one that applies, worst first. */
export function alertsFor(fix: LastFix | null, now: Date, rules: TrackingRules): Alert[] {
  const out: Alert[] = [];
  if (!fix) return out;
  const ageMin = (now.getTime() - new Date(fix.at).getTime()) / 60000;
  if (ageMin > rules.offlineAfterMin) {
    if (fix.context && !fix.context.arrivedAt) out.push({ kind: 'OFFLINE', since: fix.at, detail: `No fix for ${Math.round(ageMin)} min while on a job` });
    return out;
  }
  const context = fix.context;
  if (!context) return out;
  if (context.slotAt && !context.arrivedAt) {
    const lateMin = (now.getTime() - new Date(context.slotAt).getTime()) / 60000 - rules.lateGraceMin;
    if (lateMin > 0) out.push({ kind: 'LATE', since: context.slotAt, detail: `${Math.round(lateMin + rules.lateGraceMin)} min past the slot, not arrived` });
  }
  if (!context.arrivedAt) {
    const stillMin = (now.getTime() - new Date(fix.movingAt).getTime()) / 60000;
    if (stillMin >= rules.idleAlertMin && (fix.speed ?? 0) < WALKING_MPS) out.push({ kind: 'IDLE', since: fix.movingAt, detail: `Not moved for ${Math.round(stillMin)} min` });
    if (context.destination && fix.tripStart) {
      const offM = distanceToSegmentM(fix, fix.tripStart, context.destination);
      if (offM > rules.offRouteKm * 1000) out.push({ kind: 'OFF_ROUTE', since: fix.at, detail: `${(offM / 1000).toFixed(1)} km off the straight line to the site` });
    }
  }
  return out;
}

/** The next ping interval the app should use, by whether it is moving. */
export function nextPingSec(fix: { speed: number | null }, moved: boolean, intervals: { pingMovingSec: number; pingStillSec: number }): number {
  return (fix.speed ?? 0) >= WALKING_MPS || moved ? intervals.pingMovingSec : intervals.pingStillSec;
}
