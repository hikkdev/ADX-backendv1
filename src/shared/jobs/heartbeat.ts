import { redis } from '../cache';
import { logger } from '../logging';

/**
 * Job heartbeats — Lot E.
 *
 * Every interval job records the instant it ticked, whether or not it won its
 * lock or had anything to do: the question the ops page asks is "is the
 * process running this job at all", and a job that is alive but idle should
 * answer yes. One Redis hash, one field per job, read back by
 * `GET /settings/system-health/ops`. Never awaited by a tick — a heartbeat
 * that cannot be written is logged and the job goes on.
 */

export const HEARTBEAT_KEY = 'jobs:heartbeat';

/** The names every job ticks under. Kept as a list so the page can show a job that has never ticked. */
export const JOB_NAMES = [
  'publisher-timer',
  'agent-timer',
  'event-scraper',
  'campaign-lifecycle',
  'earnings-accrual',
  'monthly-statements',
  'kyc-provider-probe',
  'kyc-purge',
  'retention',
  'restore-drill',
  // Lot G (Q129/Q130): the five-minute health sampler and the report schedules.
  'health-sample',
  'report-schedule',
  // Lot G (Q127/142, Q118/138): the nightly KYC escalation by age and the fraud signal scan.
  'kyc-escalation',
  'fraud-signal-scan',
  // G6 (Q104): the data export builder.
  'data-export',
  // Lot G (Q124): the weekly payout draft.
  'payout-batch-draft',
  // Lot H (Q147): the nightly quote-request expiry and re-invite.
  'print-quote-expiry',
  // Lot I: the minute sweep over live chats — first-response breaches and idle conversions.
  'live-chat-sla',
  // Lot J (B1): the daily publisher-subscription sweep — expiring and ended notices, stale orders; Lot J2: the renewals.
  'publisher-subscription',
  // Lot J2 (6): the daily package-renewal sweep — the reminder and the wallet renewal for advertisers.
  'package-renewal',
  // Lot V: the hourly wind-down of a city ops pulled out of — its live listings off the market, its open leads closed, its people told.
  'city-winddown',
  // Lot AA: the daily 08:00 IST due-tomorrow / overdue notices on work tasks.
  'work-due',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function recordHeartbeat(job: JobName | string, at = new Date()): void {
  void redis
    .hset(HEARTBEAT_KEY, job, at.toISOString())
    .catch((err: unknown) => logger.warn('Job heartbeat not recorded', { job, reason: String(err) }));
}

export type Heartbeat = { job: string; lastTickAt: string | null };

/** Every known job with its last tick, plus any job that ticked under a name this build does not know. */
export async function readHeartbeats(): Promise<Heartbeat[]> {
  const stored = await redis.hgetall(HEARTBEAT_KEY);
  const known = JOB_NAMES.map((job) => ({ job, lastTickAt: stored[job] ?? null }));
  const extra = Object.keys(stored)
    .filter((job) => !(JOB_NAMES as readonly string[]).includes(job))
    .sort()
    .map((job) => ({ job, lastTickAt: stored[job] ?? null }));
  return [...known, ...extra];
}
