import { getPlatformSettings } from '../app-config';
import { prismaWorkloadRepository as repository } from './prisma-workload.repository';
import type { WorkloadGranularity, WorkloadQuery } from './employees.schema';

/**
 * The workload measure — Lot G (Q120/Q139).
 *
 * Q120 decided the workload chart is drawn from ADX's own data, not from an
 * HR tool: what each staffer is holding, and what they did. The measure is
 * deliberately simple enough to explain on the chart's legend:
 *
 *   load (items per week) =
 *       Σ open items assigned right now × weight          (KYC cases, tickets, fraud cases)
 *     + Σ diary entries in the bucket × weight × 7 / days
 *     + Σ actions taken in the bucket × weight × 7 / days
 *
 * **Open items** are a snapshot — what the person is holding today — so they
 * count into the bucket that contains today (or the last bucket of a window
 * that ended earlier), never into the past. **Actions** are the audit rows
 * the person left (`ActivityLog`), classed by their action name into
 * decisions, moderation, ops moves and replies, with sign-ins and file
 * views left out; the universal admin-write tap's rows (`module.METHOD
 * /path`) count as `other`. **Diary entries** are the `ScheduleEntry` rows
 * against the person dated in the bucket.
 *
 * The load is then banded by `getPlatformSettings().hr.workloadThresholds`
 * (defaults 10 / 25 items per week): below `medium` LOW, from `medium`
 * MEDIUM, from `high` HIGH. The share of staff in each band per bucket of
 * time is what the chart draws; the per-employee rows are the table under
 * it.
 */

export const WORKLOAD_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type WorkloadLevel = (typeof WORKLOAD_LEVELS)[number];

export const ACTION_CLASSES = ['decisions', 'moderation', 'ops', 'replies', 'other'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** How much of a week one of each counts for. Kept in code, printed on the response, so the legend can quote them. */
export const WORKLOAD_WEIGHTS = {
  open: { kyc: 2, tickets: 1, fraud: 3 },
  schedule: 1,
  actions: { decisions: 2, moderation: 1, ops: 1, replies: 0.5, other: 0.5 } satisfies Record<ActionClass, number>,
} as const;

/** Rows that are not work: sign-ins, sessions, file views, the messages the platform sent. */
const NOISE = /^(LOGIN_|SESSION|OTHER_SESSIONS_|PASSWORD_|TWO_FACTOR_|REFRESH_TOKEN_|IMPERSONATION_|FILE_VIEWED$|EMAIL$|SMS$|USER_INVITE_ACCEPTED$)/;
const DECISIONS = /(_REVIEWED|_APPROVED|_REJECTED|_DECIDED|_VERIFIED|_RESOLVED|_DISMISSED|_CONFIRMED|_RELEASED|_ACTIVATED|_REFUSED|_ACCEPTED|_MARKED_PAID|_FAILED|_VOIDED|_ISSUED)$/;
const MODERATION = /^(CREATIVE_|REVIEW_|LISTING_|SAFETY_|LANDING_PAGE_|FRAUD_CASE_|CERTIFICATION_)/;
const REPLIES = /(_NOTE_ADDED|_REUPLOAD_REQUESTED|_STATUS_CHANGED|_RESENT)$|^SUPPORT_TICKET_|^DISPUTE_/;
const OPS = /^(ORDER_|VISIT_|SCHEDULE_|PRINT_|PAYOUT_|WITHDRAWAL_|REFUND_|WALLET_|CAMPAIGN_|PUBLISHER_|ADVERTISER_|ONBOARDING_|LEAD|EMPLOYEE_|HOLIDAY_|ANNOUNCEMENT_|NOTIFICATION_|INVOICE_|BANK_|RECONCILIATION_|STATEMENT_|ACCOUNT_|ERASURE_|SUSPEN)|_ASSIGNED|_REASSIGNED|OPS_OVERRIDE/;

/** Which class an audit row's action name falls in; `null` for the noise the measure leaves out. */
export function classifyAction(action: string): ActionClass | null {
  if (NOISE.test(action)) return null;
  if (DECISIONS.test(action)) return 'decisions';
  if (MODERATION.test(action)) return 'moderation';
  if (REPLIES.test(action)) return 'replies';
  if (OPS.test(action)) return 'ops';
  return 'other';
}

export function levelFor(load: number, thresholds: { medium: number; high: number }): WorkloadLevel {
  if (load >= thresholds.high) return 'HIGH';
  if (load >= thresholds.medium) return 'MEDIUM';
  return 'LOW';
}

/* ── Buckets ─────────────────────────────────────────────────────────── */

/** The platform is India-only: a calendar day starts at 00:00 IST, and the diary's `@db.Date` is that day at UTC midnight. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_WINDOW_DAYS = 400;

export interface Bucket {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, exclusive — the next bucket's start. */
  end: string;
  days: number;
}

const dayUtc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const isoOf = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
/** The instant an Indian calendar day begins. */
export const istDayStart = (iso: string): Date => new Date(dayUtc(iso).getTime() - IST_OFFSET_MS);
/** Today, as an Indian calendar day. */
export const todayIst = (now = new Date()): string => isoOf(new Date(now.getTime() + IST_OFFSET_MS));

function alignStart(iso: string, granularity: WorkloadGranularity): Date {
  const day = dayUtc(iso);
  if (granularity === 'month') return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  // Weeks start on Monday.
  const offset = (day.getUTCDay() + 6) % 7;
  return addDays(day, -offset);
}

function nextStart(start: Date, granularity: WorkloadGranularity): Date {
  if (granularity === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return addDays(start, 7);
}

/** Whole buckets covering `[from, to]` — the first may start before `from`, the last end after `to`. */
export function bucketsFor(from: string, to: string, granularity: WorkloadGranularity): Bucket[] {
  const buckets: Bucket[] = [];
  const last = dayUtc(to);
  for (let start = alignStart(from, granularity); start <= last; start = nextStart(start, granularity)) {
    const end = nextStart(start, granularity);
    buckets.push({ start: isoOf(start), end: isoOf(end), days: Math.round((end.getTime() - start.getTime()) / DAY_MS) });
  }
  return buckets;
}

/** The window the query asks for, with the defaults: the last twelve weeks (or six months), ending today. */
export function windowFor(query: WorkloadQuery, now = new Date()): { from: string; to: string } {
  const to = query.to ?? todayIst(now);
  const spanDays = query.granularity === 'month' ? 182 : 83;
  const from = query.from ?? isoOf(addDays(dayUtc(to), -spanDays));
  return { from, to };
}

/* ── The measure ─────────────────────────────────────────────────────── */

export interface EmployeeBucketLoad {
  start: string;
  actions: Record<ActionClass, number> & { total: number };
  schedule: number;
  /** The open snapshot counted here — only in the bucket that holds today. */
  open: number;
  load: number;
  level: WorkloadLevel;
}

export interface WorkloadEmployee {
  userId: string;
  employeeId: string;
  name: string | null;
  designation: string | null;
  department: string | null;
  open: { kyc: number; tickets: number; fraud: number; total: number };
  buckets: EmployeeBucketLoad[];
}

export interface WorkloadBucketShare extends Bucket {
  staff: number;
  counts: Record<WorkloadLevel, number>;
  /** `counts / staff`, 0–1, three decimals — what the chart draws. */
  share: Record<WorkloadLevel, number>;
}

export interface WorkloadReport {
  from: string;
  to: string;
  granularity: WorkloadGranularity;
  thresholds: { medium: number; high: number };
  weights: typeof WORKLOAD_WEIGHTS;
  buckets: WorkloadBucketShare[];
  employees: WorkloadEmployee[];
}

const round = (value: number, places = 3): number => Math.round(value * 10 ** places) / 10 ** places;

export async function workloadReport(query: WorkloadQuery, now = new Date()): Promise<WorkloadReport> {
  const { from, to } = windowFor(query, now);
  const buckets = bucketsFor(from, to, query.granularity);
  if (buckets.length === 0) throw new Error('EMPTY_WINDOW');
  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  const spanDays = Math.round((dayUtc(last.end).getTime() - dayUtc(first.start).getTime()) / DAY_MS);
  if (spanDays > MAX_WINDOW_DAYS) throw new Error('WINDOW_TOO_WIDE');

  const [settings, staff] = await Promise.all([getPlatformSettings(), repository.findStaff()]);
  const thresholds = settings.hr.workloadThresholds;
  const userIds = staff.map((row) => row.userId);

  const [open, schedule, actionsPerBucket] = await Promise.all([
    repository.countOpenAssigned(userIds),
    repository.findScheduleEntries(userIds, dayUtc(first.start), dayUtc(last.end)),
    Promise.all(buckets.map((bucket) => repository.countActions(userIds, istDayStart(bucket.start), istDayStart(bucket.end)))),
  ]);

  // The snapshot of open items lands in the bucket holding today, or the last one when the window is in the past.
  const today = todayIst(now);
  const todayIndex = buckets.findIndex((bucket) => bucket.start <= today && today < bucket.end);
  const openIndex = todayIndex >= 0 ? todayIndex : today >= last.end ? buckets.length - 1 : -1;

  const openBy = new Map(open.map((row) => [row.userId, row]));
  const scheduleBy = new Map<string, number[]>();
  for (const entry of schedule) {
    const day = isoOf(entry.date);
    const index = buckets.findIndex((bucket) => bucket.start <= day && day < bucket.end);
    if (index < 0) continue;
    const counts = scheduleBy.get(entry.assigneeUserId) ?? new Array<number>(buckets.length).fill(0);
    counts[index] = (counts[index] ?? 0) + 1;
    scheduleBy.set(entry.assigneeUserId, counts);
  }

  const employees: WorkloadEmployee[] = staff.map((person) => {
    const held = openBy.get(person.userId) ?? { kyc: 0, tickets: 0, fraud: 0 };
    const openTotal = held.kyc + held.tickets + held.fraud;
    const openLoad = held.kyc * WORKLOAD_WEIGHTS.open.kyc + held.tickets * WORKLOAD_WEIGHTS.open.tickets + held.fraud * WORKLOAD_WEIGHTS.open.fraud;
    const rows = buckets.map((bucket, index) => {
      const actions: Record<ActionClass, number> & { total: number } = { decisions: 0, moderation: 0, ops: 0, replies: 0, other: 0, total: 0 };
      let actionLoad = 0;
      for (const row of actionsPerBucket[index] ?? []) {
        if (row.userId !== person.userId) continue;
        const cls = classifyAction(row.action);
        if (!cls) continue;
        actions[cls] += row.count;
        actions.total += row.count;
        actionLoad += row.count * WORKLOAD_WEIGHTS.actions[cls];
      }
      const scheduled = scheduleBy.get(person.userId)?.[index] ?? 0;
      const perWeek = 7 / bucket.days;
      const openHere = index === openIndex ? openLoad : 0;
      const load = round(openHere + scheduled * WORKLOAD_WEIGHTS.schedule * perWeek + actionLoad * perWeek);
      return { start: bucket.start, actions, schedule: scheduled, open: index === openIndex ? openTotal : 0, load, level: levelFor(load, thresholds) };
    });
    return { ...person, open: { kyc: held.kyc, tickets: held.tickets, fraud: held.fraud, total: openTotal }, buckets: rows };
  });

  const shares: WorkloadBucketShare[] = buckets.map((bucket, index) => {
    const counts: Record<WorkloadLevel, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
    for (const person of employees) counts[person.buckets[index]!.level] += 1;
    const total = employees.length;
    const share: Record<WorkloadLevel, number> = {
      LOW: total ? round(counts.LOW / total) : 0,
      MEDIUM: total ? round(counts.MEDIUM / total) : 0,
      HIGH: total ? round(counts.HIGH / total) : 0,
    };
    return { ...bucket, staff: total, counts, share };
  });

  return { from, to, granularity: query.granularity, thresholds, weights: WORKLOAD_WEIGHTS, buckets: shares, employees };
}
