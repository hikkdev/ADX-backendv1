import type { HealthSample, HealthService, Incident, IncidentSeverity, IncidentStatus, IncidentUpdate, StatusSubscriber } from '../../shared/database';
import type { ListQuery } from '../../shared/pagination';

/**
 * Persistence seam for the system-health tables — Lot G (Q130).
 *
 * Until this lot `ops` owned nothing in the schema; now it owns the five-
 * minute probe samples, the incident log and the status page's
 * subscribers. Everything else the module reads (backups, heartbeats, the
 * three AppConfig rows) still comes through `shared/` and `app-config`.
 */

export const HEALTH_SERVICES = ['API', 'POSTGRES', 'REDIS', 'STORAGE', 'JOBS'] as const;
export const INCIDENT_STATUSES = ['OPEN', 'MONITORING', 'RESOLVED'] as const;
export const INCIDENT_SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export const INCIDENT_SORTS = ['newest', 'oldest'] as const;

export interface NewHealthSample {
  service: HealthService;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
  at: Date;
}

/** One Indian day of one service: how often the probe passed and the p95 of its latency. */
export interface HealthDay {
  service: HealthService;
  date: string;
  okPct: number;
  p95Ms: number | null;
}

export interface IncidentFilter {
  q?: string | undefined;
  status?: readonly IncidentStatus[] | undefined;
  service?: HealthService | undefined;
}

export interface NewIncident {
  title: string;
  severity: IncidentSeverity;
  body: string;
  services: HealthService[];
  createdById: string;
  startedAt: Date;
}

export interface IncidentPatch {
  title?: string;
  severity?: IncidentSeverity;
  services?: HealthService[];
  body?: string;
  status?: IncidentStatus;
  resolvedAt?: Date | null;
}

export interface NewIncidentUpdate {
  status: IncidentStatus;
  body: string;
  byUserId: string;
  at: Date;
}

export type IncidentWithUpdates = Incident & { updates: IncidentUpdate[] };

export interface OpsRepository {
  writeSamples(samples: readonly NewHealthSample[]): Promise<number>;
  /** The newest sample of each service, absent for a service never sampled. */
  latestSamples(): Promise<HealthSample[]>;
  /** Per service, per Indian day since `since`, oldest first. */
  dailyHealth(since: Date): Promise<HealthDay[]>;
  pruneSamples(before: Date): Promise<number>;

  createIncident(data: NewIncident, first: NewIncidentUpdate): Promise<IncidentWithUpdates>;
  findIncident(id: string): Promise<IncidentWithUpdates | null>;
  listIncidents(filter: IncidentFilter, page: ListQuery): Promise<{ items: IncidentWithUpdates[]; total: number; counts: Record<string, number> }>;
  /** Everything not RESOLVED, newest first, with its updates. */
  openIncidents(): Promise<IncidentWithUpdates[]>;
  /** G13-B: when the newest incident naming any service started — resolved or not; null when none ever was. */
  latestIncidentAt(): Promise<Date | null>;
  /** The update row and the incident's status (and `resolvedAt`) in one transaction. */
  addUpdate(id: string, update: NewIncidentUpdate, patch: IncidentPatch): Promise<IncidentWithUpdates>;
  patchIncident(id: string, patch: IncidentPatch): Promise<IncidentWithUpdates>;

  findSubscriberByEmail(email: string): Promise<StatusSubscriber | null>;
  findSubscriberByToken(token: string): Promise<StatusSubscriber | null>;
  /** A new row, or a fresh token on an unconfirmed one; a confirmed row is returned untouched. */
  upsertSubscriber(email: string, token: string): Promise<StatusSubscriber>;
  confirmSubscriber(id: string, at: Date): Promise<StatusSubscriber>;
  deleteSubscriber(id: string): Promise<void>;
  confirmedSubscribers(): Promise<{ email: string; token: string }[]>;
  /** G11-2: how many are on the list — confirmed by link, and still waiting on the confirmation mail. */
  subscriberCounts(): Promise<{ confirmed: number; pending: number }>;
}
