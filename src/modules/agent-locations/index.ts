/**
 * LT-1 (live agent tracking, 22 Sep 2026): where every working agent is —
 * the agent app's ping, the live fix in Redis, the trail in Postgres, the
 * ops live map (list + SSE), the order timeline across both legs, and the
 * retention sweep. See README.md.
 */
export { agentLocationRouter } from './agent-locations.routes';
export { recordPing, liveAgents, agentTrail, orderTimeline, sweepTrails, endTrip, registerOrderPositionPort, trackingClientSettings, TRACKING_CONSENT_LINE, foldTimeline } from './agent-locations.service';
export type { LiveAgent, LiveFilter, OrderTimeline, TimelineStep, TrailView, PingAnswer, PingInput, OrderPositionPort, TrackingClientSettings } from './agent-locations.service';
export { distanceM, etaTo, stateOf, alertsFor } from './agent-locations.rules';
export type { AgentState, Alert, AlertKind, LatLng } from './agent-locations.rules';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
/** LH3: the last live fix, for the lead routing's "nearest agent" (through a port in bootstrap). */
export { readLastFix } from './agent-locations.store';
