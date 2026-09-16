import { readDailyServerErrors, DAILY_5XX_HISTORY_DAYS } from '../../shared/errors';
import { readHeartbeats } from '../../shared/jobs';
import { HEALTH_SAMPLE_RETENTION_DAYS, serviceHistory, type ServiceHistory } from './health-sample.service';
import { JOB_STALE_MINUTES } from './ops.service';

/**
 * E6: `GET /settings/system-health/history` — what the on-call page draws as
 * a line rather than a light: every job's last tick, and the last thirty
 * days of 5xx counts. The counts come from the hash `shared/errors`'
 * rate alert keeps beside its per-minute window (`errors:5xx:days`, one
 * field per IST day); a day with no field is a zero, and days before the
 * hash existed read zero too — the series starts the day this build first
 * served a 5xx.
 *
 * Lot G (Q130): beside it, per service, thirty Indian days of the five-
 * minute samples — `okPct` (how often the probe passed) and `p95Ms` — from
 * `HealthSample`, a day with no samples reading null.
 */
export type SystemHealthHistory = {
  generatedAt: string;
  jobs: { job: string; lastTickAt: string | null; staleMinutes: number | null; stale: boolean }[];
  serverErrors: {
    days: number;
    /** Oldest first. */
    series: { day: string; count: number }[];
    total: number;
    source: 'redis';
  };
  services: ServiceHistory;
  sampleDays: number;
};

export async function systemHealthHistory(now = new Date()): Promise<SystemHealthHistory> {
  const [heartbeats, series, services] = await Promise.all([
    readHeartbeats(),
    readDailyServerErrors(now, DAILY_5XX_HISTORY_DAYS),
    serviceHistory(now, HEALTH_SAMPLE_RETENTION_DAYS),
  ]);
  return {
    generatedAt: now.toISOString(),
    jobs: heartbeats.map(({ job, lastTickAt }) => {
      const staleMinutes = lastTickAt ? Math.floor((now.getTime() - new Date(lastTickAt).getTime()) / 60_000) : null;
      return { job, lastTickAt, staleMinutes, stale: staleMinutes === null || staleMinutes >= JOB_STALE_MINUTES };
    }),
    serverErrors: {
      days: DAILY_5XX_HISTORY_DAYS,
      series,
      total: series.reduce((sum, entry) => sum + entry.count, 0),
      source: 'redis',
    },
    services,
    sampleDays: HEALTH_SAMPLE_RETENTION_DAYS,
  };
}
