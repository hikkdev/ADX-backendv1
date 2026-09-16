import type { HealthService } from '../../shared/database';
import { pingRedis } from '../../shared/cache';
import { JOB_NAMES, readHeartbeats, type Heartbeat } from '../../shared/jobs';
import { readPreviousMinuteLatency } from '../../shared/logging';
import { probeStorage, type StorageProbe } from '../../shared/storage';
import { dayWindowISTFor } from '../../shared/time';
import { HEALTH_SERVICES, type HealthDay, type NewHealthSample } from './ops.repository';
import { JOB_STALE_MINUTES } from './ops.service';
import { prismaOpsRepository as repository } from './prisma-ops.repository';

/**
 * The five-minute health sample — Lot G (Q130).
 *
 * One row per service per tick: the API's own latency (the p95 of the
 * minute the request logger just finished keeping in Redis — no traffic is
 * an OK sample with no latency, not a failure), Postgres and Redis (the
 * readiness pings, with their round trip), storage (a HEAD on the bucket
 * through the adapter, so no key or endpoint is ever in the row) and the
 * jobs (every heartbeat fresh — a stale or never-ticked job names itself in
 * `detail`). Thirty days are kept; the tick prunes what is older.
 */

export const HEALTH_SAMPLE_RETENTION_DAYS = 30;

export type Ping = { ok: true; latencyMs: number } | { ok: false; error: string };

export interface HealthProbes {
  api(now: Date): Promise<{ p95Ms: number | null; count: number }>;
  postgres(): Promise<Ping>;
  redis(): Promise<Ping>;
  storage(): Promise<StorageProbe>;
  heartbeats(): Promise<Heartbeat[]>;
}

/**
 * The Postgres ping lives in `shared/database`, which a module may only
 * import for types (the repository rule), so bootstrap registers it here
 * the way the other ports are filled. Unregistered, the sample is honest:
 * POSTGRES reads down with the reason, never silently up.
 */
let postgresProbe: () => Promise<Ping> = async () => ({ ok: false, error: 'postgres probe not registered' });

export function registerPostgresProbe(probe: () => Promise<Ping>): void {
  postgresProbe = probe;
}

export const defaultHealthProbes: HealthProbes = {
  api: (now) => readPreviousMinuteLatency(now),
  postgres: () => postgresProbe(),
  redis: () => pingRedis(),
  storage: () => probeStorage(),
  heartbeats: () => readHeartbeats(),
};

/** A probe's message can quote a connection string — host, user, password — so any `scheme://…` is masked before it is written to a table every admin reads. */
const clip = (text: string) => text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, 200);

/** Which of the known jobs have not ticked within the stale window. */
export function staleJobs(heartbeats: readonly Heartbeat[], now: Date): string[] {
  const seen = new Map(heartbeats.map((h) => [h.job, h.lastTickAt]));
  return JOB_NAMES.filter((job) => {
    const last = seen.get(job) ?? null;
    return last === null || (now.getTime() - new Date(last).getTime()) / 60_000 >= JOB_STALE_MINUTES;
  });
}

/** Probes everything once and shapes the five rows; writes nothing. */
export async function probeAll(now: Date, probes: HealthProbes = defaultHealthProbes): Promise<NewHealthSample[]> {
  const settle = <T>(p: Promise<T>): Promise<T | Error> => p.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
  const [api, postgres, redis, storage, heartbeats] = await Promise.all([
    settle(probes.api(now)),
    settle(probes.postgres()),
    settle(probes.redis()),
    settle(probes.storage()),
    settle(probes.heartbeats()),
  ]);

  const failed = (service: HealthService, err: Error): NewHealthSample => ({ service, ok: false, latencyMs: null, detail: clip(err.message), at: now });
  const ping = (service: HealthService, result: Ping | Error): NewHealthSample =>
    result instanceof Error
      ? failed(service, result)
      : result.ok
        ? { service, ok: true, latencyMs: result.latencyMs, detail: null, at: now }
        : { service, ok: false, latencyMs: null, detail: clip(result.error), at: now };

  const apiSample: NewHealthSample =
    api instanceof Error
      ? failed('API', api)
      : { service: 'API', ok: true, latencyMs: api.p95Ms, detail: api.count === 0 ? 'no requests in the minute' : `${api.count} requests`, at: now };

  const storageSample: NewHealthSample =
    storage instanceof Error
      ? failed('STORAGE', storage)
      : storage.ok
        ? { service: 'STORAGE', ok: true, latencyMs: storage.latencyMs, detail: storage.provider, at: now }
        : { service: 'STORAGE', ok: false, latencyMs: storage.latencyMs, detail: `${storage.provider}: ${clip(storage.error)}`, at: now };

  const stale = heartbeats instanceof Error ? null : staleJobs(heartbeats, now);
  const jobsSample: NewHealthSample =
    heartbeats instanceof Error
      ? failed('JOBS', heartbeats)
      : { service: 'JOBS', ok: stale!.length === 0, latencyMs: null, detail: stale!.length === 0 ? `${JOB_NAMES.length} jobs fresh` : `stale: ${stale!.join(', ')}`, at: now };

  return [apiSample, ping('POSTGRES', postgres), ping('REDIS', redis), storageSample, jobsSample];
}

export interface HealthSampleResult {
  written: number;
  pruned: number;
  samples: NewHealthSample[];
}

/** The job's tick: probe, write the five rows, prune past thirty days. */
export async function sampleHealth(now = new Date(), probes: HealthProbes = defaultHealthProbes): Promise<HealthSampleResult> {
  const samples = await probeAll(now, probes);
  const written = await repository.writeSamples(samples);
  const pruned = await repository.pruneSamples(new Date(now.getTime() - HEALTH_SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000));
  return { written, pruned, samples };
}

/* ── the thirty-day series ───────────────────────────────────────── */

export type ServiceHistory = Record<HealthService, { days: { date: string; okPct: number | null; p95Ms: number | null }[] }>;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDay = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Per service, one entry per Indian day of the last `days` (oldest first),
 * a day with no samples reading null rather than being left out, so the
 * five graphs share an axis.
 */
export async function serviceHistory(now = new Date(), days = HEALTH_SAMPLE_RETENTION_DAYS): Promise<ServiceHistory> {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(istDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  const rows = await repository.dailyHealth(dayWindowISTFor(dates[0]!).start);
  const byKey = new Map<string, HealthDay>(rows.map((row) => [`${row.service}:${row.date}`, row]));

  const out = {} as ServiceHistory;
  for (const service of HEALTH_SERVICES) {
    out[service] = {
      days: dates.map((date) => {
        const row = byKey.get(`${service}:${date}`);
        return { date, okPct: row ? row.okPct : null, p95Ms: row ? row.p95Ms : null };
      }),
    };
  }
  return out;
}
