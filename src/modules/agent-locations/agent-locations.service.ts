import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import type { TrailKind } from '../../shared/database';
import { getPlatformSettings, type PlatformSettings } from '../app-config';
import { findAgentProfile } from '../agents';
import { prismaAgentLocationsRepository as repository } from './prisma-agent-locations.repository';
import type { AgentSummary, OrderTimelineFacts, TrailRow, TripContext } from './agent-locations.repository';
import {
  alertsFor,
  distanceM,
  etaTo,
  isArrived,
  nextPingSec,
  stateOf,
  worthKeeping,
  STILL_RADIUS_M,
  type Alert,
  type AgentState,
  type LastFix,
  type LatLng,
  type TrackingRules,
} from './agent-locations.rules';
import { clearFixContext, listLastFixes, readLastFix, writeLastFix } from './agent-locations.store';

/**
 * LT-1 (live agent tracking, 22 Sep 2026): where every working agent is.
 *
 * The agent app reports its position (`POST /agent-locations/me`) while it
 * is open and the agent is active — every `pingMovingSec` on the move,
 * every `pingStillSec` standing still, the intervals read off the platform
 * settings once a session. Each ping:
 *
 *  - becomes the agent's live record in Redis (`agent-locations.store`) —
 *    position, speed, heading, the trip it is on, when it last moved;
 *  - when the ping names a trip (an order, a milestone, a field visit) the
 *    agent is actually on, opens or continues the trail in Postgres and
 *    keeps the fix if it is worth keeping (`worthKeeping`: 25 m or 60 s
 *    from the last), stamps `arrivedAt` the first time the fix lands inside
 *    the geofence, and keeps the order's own `agentLatitude/Longitude` (the
 *    parties' tracking screens read those) through the orders module;
 *  - answers with the next interval and whether the trip has arrived.
 *
 * The live map reads the Redis records for every active agent, derives a
 * state (`stateOf`) and the alerts (`alertsFor`), and the console holds an
 * SSE stream that re-sends the list every few seconds while anything
 * moved (`agent-locations.stream`). The order timeline folds the trail
 * into the job's own moments: print ready → en route to the partner →
 * pickup scan → en route to the site → arrived → installed.
 *
 * The trails are swept after `retentionDays`; the live record expires by
 * itself after a day.
 */

export type TrackingSettings = PlatformSettings['tracking'];

export type PingInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null | undefined;
  speed?: number | null | undefined;
  heading?: number | null | undefined;
  /** The phone's clock; the server's when absent or absurd. */
  at?: string | null | undefined;
  context?: { kind: TrailKind; id: string } | null | undefined;
};

export type PingAnswer = {
  accepted: true;
  state: AgentState;
  nextPingSec: number;
  trip: { kind: TrailKind; id: string; label: string; arrived: boolean; arrivedAt: string | null; eta: { minutes: number; distanceM: number } | null } | null;
};

/** What the app reads once a session: the intervals, the mode, the consent line. */
export type TrackingClientSettings = {
  pingMovingSec: number;
  pingStillSec: number;
  mode: TrackingSettings['mode'];
  geofenceRadiusM: number;
  consent: string;
};

export const TRACKING_CONSENT_LINE =
  'While the ADX Agent app is open and you are on a job, it shares your position with ADX every minute or so — so the desk can see where you are, tell the customer when you will arrive, and help if something goes wrong. Nothing is shared when the app is closed or you are not on a job.';

export async function trackingSettings(): Promise<TrackingSettings> {
  return (await getPlatformSettings()).tracking;
}

export async function trackingClientSettings(): Promise<TrackingClientSettings> {
  const settings = await trackingSettings();
  return { pingMovingSec: settings.pingMovingSec, pingStillSec: settings.pingStillSec, mode: settings.mode, geofenceRadiusM: settings.geofenceRadiusM, consent: TRACKING_CONSENT_LINE };
}

const rulesOf = (settings: TrackingSettings): TrackingRules => ({
  geofenceRadiusM: settings.geofenceRadiusM,
  idleAlertMin: settings.idleAlertMin,
  lateGraceMin: settings.lateGraceMin,
  offRouteKm: settings.offRouteKm,
  offlineAfterMin: settings.offlineAfterMin,
});

/** The phone's clock, unless it is missing or more than ten minutes off — then the server's. */
function fixTime(at: string | null | undefined, now: Date): Date {
  if (!at) return now;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime()) || Math.abs(parsed.getTime() - now.getTime()) > 10 * 60 * 1000) return now;
  return parsed;
}

/* ------------------------------------------------------------------ */
/* The ping                                                            */
/* ------------------------------------------------------------------ */

/** A port the orders module fills so the parties' tracking screens keep reading the order's own columns. */
export type OrderPositionPort = { update(orderId: string, coords: LatLng): Promise<void> };
let orderPosition: OrderPositionPort | null = null;
export function registerOrderPositionPort(port: OrderPositionPort | null): void {
  orderPosition = port;
}

export async function recordPing(userId: string, input: PingInput, now = new Date()): Promise<PingAnswer> {
  const agent = await findAgentProfile(userId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  const settings = await trackingSettings();
  const rules = rulesOf(settings);
  const at = fixTime(input.at, now);
  const here: LatLng = { latitude: input.latitude, longitude: input.longitude };
  const previous = await readLastFix(agent.id);

  // The trip the ping names, if it is the agent's and still open.
  let trip: TripContext | null = null;
  if (input.context) {
    const context = await repository.tripContext(input.context.kind, input.context.id);
    if (context && context.agentId === agent.id && context.open) trip = context;
  }

  const moved = !previous || distanceM(previous, here) >= STILL_RADIUS_M;
  const sameTrip = Boolean(previous?.context && trip && previous.context.kind === trip.kind && previous.context.id === trip.id);
  let arrivedAt: string | null = sameTrip ? (previous!.context!.arrivedAt ?? null) : null;

  if (trip) {
    let trail = await repository.findTrail(agent.id, trip.kind, trip.id);
    if (!trail) {
      trail = await repository.openTrail({ agentId: agent.id, kind: trip.kind, contextId: trip.id, orderId: trip.orderId, destination: trip.destination, destinationLabel: trip.label, startedAt: at });
    } else if (trail.endedAt) {
      // A trip that went quiet and came back: reopen it rather than lose the history.
      await repository.touchTrail(trail.id, { endedAt: null });
    }
    const last = await repository.lastPoint(trail.id);
    if (worthKeeping(last, { ...here, at })) {
      await repository.appendPoint(trail.id, { agentId: agent.id, ...here, accuracy: input.accuracy ?? null, speed: input.speed ?? null, heading: input.heading ?? null, at }, last ? distanceM(last, here) : 0);
    } else {
      await repository.touchTrail(trail.id, { lastFixAt: at });
    }
    arrivedAt = trail.arrivedAt?.toISOString() ?? arrivedAt;
    // The destination moves from the shop to the site at the handover scan: an arrival is per leg.
    const legChanged = Boolean(previous?.context && sameTrip && previous.context.label !== trip.label);
    if (legChanged) arrivedAt = null;
    if (!arrivedAt && isArrived(here, trip.destination, rules)) {
      arrivedAt = at.toISOString();
      await repository.touchTrail(trail.id, { arrivedAt: at });
    }
    if (trip.orderId && orderPosition) {
      await orderPosition.update(trip.orderId, here).catch((cause) => logger.warn('Order position update failed', { orderId: trip!.orderId, err: cause }));
    }
  }

  const fix: LastFix = {
    agentId: agent.id,
    latitude: here.latitude,
    longitude: here.longitude,
    at: at.toISOString(),
    accuracy: input.accuracy ?? null,
    speed: input.speed ?? null,
    heading: input.heading ?? null,
    context: trip
      ? { kind: trip.kind, id: trip.id, orderId: trip.orderId, label: trip.label, destination: trip.destination, slotAt: trip.slotAt?.toISOString() ?? null, arrivedAt }
      : null,
    movingAt: moved || !previous ? at.toISOString() : previous.movingAt,
    tripStart: trip ? (sameTrip && previous?.tripStart ? previous.tripStart : here) : null,
  };
  await writeLastFix(fix);

  return {
    accepted: true,
    state: stateOf(fix, now, rules),
    nextPingSec: nextPingSec(fix, moved, settings),
    trip: trip ? { kind: trip.kind, id: trip.id, label: trip.label, arrived: Boolean(arrivedAt), arrivedAt, eta: arrivedAt ? null : etaTo(fix, trip.destination) } : null,
  };
}

/** The agent's trip closed elsewhere (the job moved on): the live record loses its trip and the trail ends. Best-effort. */
export async function endTrip(agentId: string, kind: TrailKind, contextId: string, now = new Date()): Promise<void> {
  const trail = await repository.findTrail(agentId, kind, contextId);
  if (trail && !trail.endedAt) await repository.touchTrail(trail.id, { endedAt: now });
  await clearFixContext(agentId);
}

/* ------------------------------------------------------------------ */
/* The live map                                                        */
/* ------------------------------------------------------------------ */

export type LiveAgent = {
  agent: AgentSummary;
  state: AgentState;
  fix: (LatLng & { at: string; accuracy: number | null; speed: number | null; heading: number | null; ageSec: number }) | null;
  trip: { kind: TrailKind; id: string; orderId: string | null; label: string; destination: LatLng | null; slotAt: string | null; arrivedAt: string | null; eta: { minutes: number; distanceM: number } | null } | null;
  alerts: Alert[];
};

export type LiveFilter = { city?: string | undefined; side?: 'PUBLISHER' | 'ADVERTISER' | undefined; state?: AgentState | undefined; q?: string | undefined };

/** Every active agent, with or without a fix, as the live map lists them — alerts first, then by state, then by name. */
export async function liveAgents(filter: LiveFilter = {}, now = new Date()): Promise<{ agents: LiveAgent[]; counts: Record<AgentState, number>; alerts: number; at: string }> {
  const settings = await trackingSettings();
  const rules = rulesOf(settings);
  const [active, fixes] = await Promise.all([repository.activeAgents({ city: filter.city }), listLastFixes(new Date(now.getTime() - 24 * 60 * 60 * 1000))]);
  const byId = new Map(fixes.map((fix) => [fix.agentId, fix]));
  // An agent with a fix but not in the active list (held, exited, another city): still shown when the filter is not by city.
  const known = new Map(active.map((agent) => [agent.id, agent]));
  const extra = fixes.map((fix) => fix.agentId).filter((id) => !known.has(id));
  if (extra.length > 0 && !filter.city) for (const agent of await repository.agentSummaries(extra)) known.set(agent.id, agent);

  const rows: LiveAgent[] = [];
  for (const agent of known.values()) {
    if (filter.side && !agent.sides.includes(filter.side)) continue;
    if (filter.q) {
      const needle = filter.q.toLowerCase();
      if (!agent.name.toLowerCase().includes(needle) && !(agent.displayId ?? '').toLowerCase().includes(needle) && !agent.mobile.includes(needle)) continue;
    }
    const fix = byId.get(agent.id) ?? null;
    const state = stateOf(fix, now, rules);
    if (filter.state && state !== filter.state) continue;
    rows.push({
      agent,
      state,
      fix: fix ? { latitude: fix.latitude, longitude: fix.longitude, at: fix.at, accuracy: fix.accuracy, speed: fix.speed, heading: fix.heading, ageSec: Math.max(0, Math.round((now.getTime() - new Date(fix.at).getTime()) / 1000)) } : null,
      trip: fix?.context ? { ...fix.context, eta: fix.context.arrivedAt ? null : etaTo(fix, fix.context.destination) } : null,
      alerts: alertsFor(fix, now, rules),
    });
  }
  const order: AgentState[] = ['TRAVELLING', 'STILL', 'ON_SITE', 'AVAILABLE', 'OFFLINE'];
  rows.sort((a, b) => b.alerts.length - a.alerts.length || order.indexOf(a.state) - order.indexOf(b.state) || a.agent.name.localeCompare(b.agent.name));
  const counts: Record<AgentState, number> = { OFFLINE: 0, AVAILABLE: 0, TRAVELLING: 0, ON_SITE: 0, STILL: 0 };
  for (const row of rows) counts[row.state] += 1;
  return { agents: rows, counts, alerts: rows.reduce((n, row) => n + row.alerts.length, 0), at: now.toISOString() };
}

/** A short fingerprint of what the map would draw — the stream re-sends only when it changes. */
export function liveFingerprint(snapshot: Awaited<ReturnType<typeof liveAgents>>): string {
  return snapshot.agents.map((row) => `${row.agent.id}:${row.state}:${row.fix?.at ?? ''}:${row.trip?.arrivedAt ?? ''}:${row.alerts.map((a) => a.kind).join('+')}`).join('|');
}

/* ------------------------------------------------------------------ */
/* One agent's trail                                                   */
/* ------------------------------------------------------------------ */

export type TrailView = {
  id: string;
  kind: TrailKind;
  contextId: string;
  orderId: string | null;
  label: string | null;
  destination: LatLng | null;
  startedAt: Date;
  lastFixAt: Date;
  arrivedAt: Date | null;
  endedAt: Date | null;
  pointCount: number;
  distanceM: number;
  points: (LatLng & { at: Date; speed: number | null })[];
};

const MAX_POINTS = 2000;

function trailView(trail: TrailRow, points: { latitude: number; longitude: number; at: Date; speed: number | null }[]): TrailView {
  return {
    id: trail.id,
    kind: trail.kind,
    contextId: trail.contextId,
    orderId: trail.orderId,
    label: trail.destinationLabel,
    destination: trail.destinationLat !== null && trail.destinationLng !== null ? { latitude: trail.destinationLat, longitude: trail.destinationLng } : null,
    startedAt: trail.startedAt,
    lastFixAt: trail.lastFixAt,
    arrivedAt: trail.arrivedAt,
    endedAt: trail.endedAt,
    pointCount: trail.pointCount,
    distanceM: Math.round(trail.distanceM),
    points: points.map((p) => ({ latitude: p.latitude, longitude: p.longitude, at: p.at, speed: p.speed })),
  };
}

/** The agent's current trip's trail (or the newest open one), with its points — what the map draws behind the marker. */
export async function agentTrail(agentId: string): Promise<TrailView | null> {
  const fix = await readLastFix(agentId);
  let trail: TrailRow | null = null;
  if (fix?.context) trail = await repository.findTrail(agentId, fix.context.kind, fix.context.id);
  if (!trail) trail = (await repository.openTrailsFor(agentId))[0] ?? null;
  if (!trail) return null;
  return trailView(trail, await repository.points(trail.id, MAX_POINTS));
}

/* ------------------------------------------------------------------ */
/* The order timeline                                                  */
/* ------------------------------------------------------------------ */

export type TimelineStep = {
  key: 'PRINT_READY' | 'TO_PARTNER' | 'PICKUP' | 'TO_SITE' | 'ARRIVED' | 'INSTALLED';
  label: string;
  at: Date | null;
  /** Where the fact came from — the print job, the trail, the milestone. */
  source: 'order' | 'print-job' | 'trail' | 'milestone';
  done: boolean;
};

export type OrderTimeline = {
  order: OrderTimelineFacts;
  steps: TimelineStep[];
  trails: TrailView[];
  live: LiveAgent | null;
};

/** The two legs of an install, in order, from the job's own moments and the trail behind them. */
export function foldTimeline(facts: OrderTimelineFacts, trails: TrailRow[]): TimelineStep[] {
  const orderTrail = trails.find((t) => t.kind === 'ORDER') ?? null;
  const printReadyAt = facts.printJob?.readyAt ?? facts.printReadyAt;
  const pickupAt = facts.printJob?.handoverAt ?? null;
  const steps: TimelineStep[] = [];
  if (facts.printJob) {
    steps.push({ key: 'PRINT_READY', label: `Print ready at ${facts.printJob.partnerName}`, at: printReadyAt, source: 'print-job', done: printReadyAt !== null });
    steps.push({ key: 'TO_PARTNER', label: 'En route to the partner', at: orderTrail && printReadyAt && !pickupAt ? orderTrail.startedAt : orderTrail && pickupAt && orderTrail.startedAt < pickupAt ? orderTrail.startedAt : null, source: 'trail', done: Boolean(pickupAt) || Boolean(orderTrail && printReadyAt && !pickupAt) });
    steps.push({ key: 'PICKUP', label: 'Pickup scan', at: pickupAt, source: 'print-job', done: pickupAt !== null });
  }
  const toSiteAt = orderTrail ? (facts.printJob ? pickupAt : orderTrail.startedAt) : null;
  steps.push({ key: 'TO_SITE', label: `En route to ${facts.site.title}`, at: toSiteAt, source: 'trail', done: toSiteAt !== null });
  const arrivedAt = orderTrail?.arrivedAt && (!pickupAt || orderTrail.arrivedAt > pickupAt) ? orderTrail.arrivedAt : null;
  steps.push({ key: 'ARRIVED', label: 'Arrived at the site', at: arrivedAt, source: 'trail', done: arrivedAt !== null });
  const installedAt = facts.installation?.completedAt ?? facts.completedAt;
  steps.push({ key: 'INSTALLED', label: 'Installed', at: installedAt, source: facts.installation ? 'milestone' : 'order', done: installedAt !== null });
  return steps;
}

export async function orderTimeline(orderId: string, now = new Date()): Promise<OrderTimeline> {
  const facts = await repository.orderTimelineFacts(orderId);
  if (!facts) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  const trails = await repository.trailsForOrder(orderId);
  const views = await Promise.all(trails.map(async (trail) => trailView(trail, await repository.points(trail.id, MAX_POINTS))));
  let live: LiveAgent | null = null;
  if (facts.agentId) {
    const snapshot = await liveAgents({}, now);
    live = snapshot.agents.find((row) => row.agent.id === facts.agentId) ?? null;
  }
  return { order: facts, steps: foldTimeline(facts, trails), trails: views, live };
}

/* ------------------------------------------------------------------ */
/* The sweep                                                           */
/* ------------------------------------------------------------------ */

export async function sweepTrails(now = new Date()): Promise<{ trails: number; points: number; retentionDays: number }> {
  const settings = await trackingSettings();
  const cut = new Date(now.getTime() - settings.retentionDays * 24 * 60 * 60 * 1000);
  const purged = await repository.purgeBefore(cut);
  return { ...purged, retentionDays: settings.retentionDays };
}
