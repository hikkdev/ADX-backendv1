import type { AgentLocationPoint, AgentTrail, TrailKind } from '../../shared/database';
import type { LatLng } from './agent-locations.rules';

/**
 * LT-1: the trails (Postgres) and the narrow reads the tracking needs from
 * the rows a trip is about — where an order's site and print partner are,
 * when its slot is, who the agent is. Read here rather than through the
 * owning modules because a destination is three columns, not a service.
 */

export type TrailRow = AgentTrail;
export type PointRow = AgentLocationPoint;

/** What a trip is going to, and when it was meant to be there. */
export type TripContext = {
  kind: TrailKind;
  id: string;
  orderId: string | null;
  agentId: string | null;
  label: string;
  destination: LatLng | null;
  /** The slot the desk agreed, when there is one. */
  slotAt: Date | null;
  /** Whether the context is still a live trip — a closed job ends the trail. */
  open: boolean;
  /** ORDER: the print partner's shop, the first leg, until the handover is confirmed. */
  pickup: { partnerId: string; name: string; point: LatLng | null; readyAt: Date | null; handoverAt: Date | null } | null;
};

export type AgentSummary = {
  id: string;
  displayId: string | null;
  userId: string;
  name: string;
  mobile: string;
  city: string | null;
  sides: ('PUBLISHER' | 'ADVERTISER')[];
  status: string;
  stage: string;
};

export type NewPoint = LatLng & { agentId: string; accuracy: number | null; speed: number | null; heading: number | null; at: Date };

export type OrderTimelineFacts = {
  id: string;
  reference: string | null;
  status: string;
  agentId: string | null;
  slotTime: Date | null;
  printReadyAt: Date | null;
  site: { title: string; point: LatLng | null };
  printJob: { partnerName: string; point: LatLng | null; readyAt: Date | null; handoverAt: Date | null } | null;
  installation: { status: string; startedAt: Date | null; completedAt: Date | null } | null;
  completedAt: Date | null;
};

export interface AgentLocationsRepository {
  /** The trip a context names, as it stands now; null for a context that does not exist. */
  tripContext(kind: TrailKind, id: string): Promise<TripContext | null>;
  agentSummaries(ids: readonly string[]): Promise<AgentSummary[]>;
  /** Every ACTIVE agent (stage ACTIVE) — the live map lists them whether or not they have a fix. */
  activeAgents(filter: { city?: string | undefined }): Promise<AgentSummary[]>;

  findTrail(agentId: string, kind: TrailKind, contextId: string): Promise<TrailRow | null>;
  openTrail(data: { agentId: string; kind: TrailKind; contextId: string; orderId: string | null; destination: LatLng | null; destinationLabel: string | null; startedAt: Date }): Promise<TrailRow>;
  /** The last point kept on the trail, for the thinning rule. */
  lastPoint(trailId: string): Promise<PointRow | null>;
  appendPoint(trailId: string, point: NewPoint, distanceM: number): Promise<void>;
  touchTrail(trailId: string, patch: { lastFixAt?: Date; arrivedAt?: Date | null; endedAt?: Date | null }): Promise<void>;
  /** The trail's points in time order, capped. */
  points(trailId: string, limit: number): Promise<PointRow[]>;
  /** The trails an order's timeline reads — the job's and its milestones'. */
  trailsForOrder(orderId: string): Promise<TrailRow[]>;
  /** The agent's open trail (no endedAt), newest first. */
  openTrailsFor(agentId: string): Promise<TrailRow[]>;
  /** Trails and points older than the cut, for the sweep. */
  purgeBefore(cut: Date): Promise<{ trails: number; points: number }>;

  orderTimelineFacts(orderId: string): Promise<OrderTimelineFacts | null>;
}
