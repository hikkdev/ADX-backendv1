import { randomBytes } from 'crypto';
import { env } from '../../config/env';
import type { HealthSample, HealthService, IncidentSeverity } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { readRecentRequestCounts, type RequestCounts } from '../../shared/logging';
import { getPlatformSettings } from '../app-config';
import { notify } from '../notifications';
import { defaultHealthProbes, type HealthProbes } from './health-sample.service';
import { HEALTH_SERVICES, type IncidentWithUpdates } from './ops.repository';
import { prismaOpsRepository as repository } from './prisma-ops.repository';
import { confirmUrlFor } from './status.links';

/**
 * The public status page — Lot G (Q130).
 *
 * `GET /status` is read by anyone, so it says only what a status page says:
 * per service, OPERATIONAL / DEGRADED / OUTAGE / UNKNOWN with the latest
 * latency and when it was sampled; the open incidents with their updates;
 * the region. No sample `detail` (a probe's error text can quote a host),
 * no user ids, no counts of anything.
 *
 * A service's state is its newest sample: missing or older than
 * `health.sampleStaleMinutes` is UNKNOWN (the sampler itself has stopped),
 * a failed probe is OUTAGE, an API p95 over `health.apiP95DegradedMs` is
 * DEGRADED. An open incident naming the service raises it to at least
 * DEGRADED, CRITICAL to OUTAGE — ops' word outranks a passing probe.
 */

export const SERVICE_STATES = ['OPERATIONAL', 'DEGRADED', 'OUTAGE', 'UNKNOWN'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

const RANK: Record<ServiceState, number> = { OPERATIONAL: 0, UNKNOWN: 1, DEGRADED: 2, OUTAGE: 3 };
const worse = (a: ServiceState, b: ServiceState): ServiceState => (RANK[b] > RANK[a] ? b : a);

export interface PublicServiceStatus {
  service: HealthService;
  status: ServiceState;
  latencyMs: number | null;
  sampledAt: string | null;
}

export interface PublicIncident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: string;
  services: HealthService[];
  startedAt: string;
  updates: { status: string; body: string; at: string }[];
}

export interface PublicStatus {
  region: string;
  generatedAt: string;
  overall: ServiceState;
  services: PublicServiceStatus[];
  incidents: PublicIncident[];
}

const incidentState = (severity: IncidentSeverity): ServiceState => (severity === 'CRITICAL' ? 'OUTAGE' : 'DEGRADED');

/** Pure: the per-service state from the newest samples, the open incidents and the thresholds. */
export function deriveServiceStates(
  samples: readonly HealthSample[],
  incidents: readonly Pick<IncidentWithUpdates, 'severity' | 'services'>[],
  thresholds: { apiP95DegradedMs: number; sampleStaleMinutes: number },
  now: Date,
): PublicServiceStatus[] {
  const latest = new Map(samples.map((sample) => [sample.service, sample]));
  return HEALTH_SERVICES.map((service) => {
    const sample = latest.get(service);
    let status: ServiceState;
    if (!sample || now.getTime() - sample.at.getTime() > thresholds.sampleStaleMinutes * 60_000) status = 'UNKNOWN';
    else if (!sample.ok) status = 'OUTAGE';
    else if (service === 'API' && sample.latencyMs !== null && sample.latencyMs > thresholds.apiP95DegradedMs) status = 'DEGRADED';
    else status = 'OPERATIONAL';
    for (const incident of incidents) {
      if (incident.services.includes(service)) status = worse(status, incidentState(incident.severity));
    }
    return { service, status, latencyMs: sample?.latencyMs ?? null, sampledAt: sample ? sample.at.toISOString() : null };
  });
}

export function shapePublicIncident(incident: IncidentWithUpdates): PublicIncident {
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    services: incident.services,
    startedAt: incident.startedAt.toISOString(),
    updates: incident.updates.map((update) => ({ status: update.status, body: update.body, at: update.at.toISOString() })),
  };
}

export async function publicStatus(now = new Date()): Promise<PublicStatus> {
  const [samples, incidents, settings] = await Promise.all([repository.latestSamples(), repository.openIncidents(), getPlatformSettings()]);
  const services = deriveServiceStates(samples, incidents, settings.health, now);
  const overall = services.reduce<ServiceState>((acc, s) => worse(acc, s.status), 'OPERATIONAL');
  return {
    region: env.APP_REGION,
    generatedAt: now.toISOString(),
    overall,
    services,
    incidents: incidents.map(shapePublicIncident),
  };
}

/* ── subscribers ─────────────────────────────────────────────────── */

const newToken = (): string => randomBytes(24).toString('base64url');

/**
 * `POST /status/subscribe`. A new or unconfirmed address gets a fresh token
 * and a confirmation mail, sent in the request; a confirmed one gets
 * nothing — and the answer is the same either way, so the form cannot be
 * used to learn who is subscribed.
 */
export async function subscribe(email: string): Promise<{ sent: boolean }> {
  const normalised = email.trim().toLowerCase();
  const row = await repository.upsertSubscriber(normalised, newToken());
  if (row.confirmedAt) return { sent: false };
  await notify('STATUS_SUBSCRIBE_CONFIRM', null, { confirmUrl: confirmUrlFor(row.token) }, { recipient: { email: normalised }, type: 'SYSTEM', immediate: true });
  return { sent: true };
}

export async function confirmSubscription(token: string, now = new Date()): Promise<{ email: string; alreadyConfirmed: boolean }> {
  const row = await repository.findSubscriberByToken(token);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'This confirmation link is not valid');
  if (row.confirmedAt) return { email: row.email, alreadyConfirmed: true };
  await repository.confirmSubscriber(row.id, now);
  return { email: row.email, alreadyConfirmed: false };
}

export async function unsubscribe(token: string): Promise<{ email: string }> {
  const row = await repository.findSubscriberByToken(token);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'This unsubscribe link is not valid');
  await repository.deleteSubscriber(row.id);
  return { email: row.email };
}

/* ── regions ─────────────────────────────────────────────────────── */

export interface RegionStatus {
  region: string;
  current: boolean;
  latency: { postgresMs: number | null; redisMs: number | null; apiP95Ms: number | null };
  /**
   * G13-B: the 5xx share of the requests this region served over the last
   * 24 hours, to two places; null when it served none (or the counters are
   * unreadable). From the hourly request counters `shared/logging` keeps.
   */
  errorRatePct: number | null;
  /** G13-B: when the newest incident naming any of the region's services started; null when none ever did. */
  lastIncidentAt: string | null;
  checkedAt: string;
}

/** The 5xx share, to two places; null with nothing served. */
export function errorRatePctOf(counts: Pick<RequestCounts, 'requests' | 'serverErrors'>): number | null {
  if (counts.requests <= 0) return null;
  return Math.round((counts.serverErrors / counts.requests) * 10_000) / 100;
}

/**
 * `GET /settings/system-health/regions`: the one region this process runs
 * in, with a live round trip to each store; G13-B: its 5xx share over the
 * last 24 h and its newest incident beside them.
 */
export async function regions(
  now = new Date(),
  probes: HealthProbes = defaultHealthProbes,
  counters: (now: Date) => Promise<RequestCounts> = readRecentRequestCounts,
): Promise<{ regions: RegionStatus[] }> {
  const [postgres, redis, api, counts, lastIncidentAt] = await Promise.all([
    probes.postgres().catch(() => ({ ok: false as const, error: 'probe threw' })),
    probes.redis().catch(() => ({ ok: false as const, error: 'probe threw' })),
    probes.api(now).catch(() => ({ p95Ms: null, count: 0 })),
    counters(now).catch(() => null),
    repository.latestIncidentAt().catch(() => null),
  ]);
  return {
    regions: [
      {
        region: env.APP_REGION,
        current: true,
        latency: { postgresMs: postgres.ok ? postgres.latencyMs : null, redisMs: redis.ok ? redis.latencyMs : null, apiP95Ms: api.p95Ms },
        errorRatePct: counts ? errorRatePctOf(counts) : null,
        lastIncidentAt: lastIncidentAt ? lastIncidentAt.toISOString() : null,
        checkedAt: now.toISOString(),
      },
    ],
  };
}
