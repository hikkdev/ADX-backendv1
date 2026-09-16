import { auditDiff, logActivity } from '../../shared/audit';
import { money } from '../../shared/money';
import { getPlatformSettings } from '../app-config';
import { createBatch, getBatch, setBatchLines } from './batches.service';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import type { BatchView } from './payouts.repository';

/**
 * The weekly payout draft — Lot G (Q124).
 *
 * On the cadence the platform settings name (`finance.payoutBatchCadence`:
 * a weekday and an Indian hour, Monday 10:00 by default) a job builds one
 * DRAFT batch from every APPROVED withdrawal that sits in no open batch, as
 * the system user, and tells the finance admins it is there. That is the
 * whole of it: the draft is what a person would have built by hand on Monday
 * morning, and submit, four-eyes approval and release stay theirs. Nothing
 * here moves money or changes a line's status — attaching a line to a draft
 * is the same reservation it already had, and cancelling the draft hands
 * the lines back.
 *
 * The cadence arithmetic is pure so the job and the schedule read agree on
 * the same instants: `lastSlot` is the most recent instant on the cadence at
 * or before `now`, `nextRunAt` the one after it.
 */

export const SCHEDULE_NOTE_PREFIX = 'Drafted by the weekly payout schedule';
/** A draft takes at most this many lines; what is left waits for the next cadence, or a person. */
export const SCHEDULE_DRAFT_MAX_LINES = 500;

export type PayoutBatchCadence = { enabled: boolean; weekday: number; hourIst: number };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most recent instant on the cadence at or before `now` — `weekday` (Sunday 0) at `hourIst`, Indian time. */
export function lastSlot(cadence: Pick<PayoutBatchCadence, 'weekday' | 'hourIst'>, now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const daysBack = (shifted.getUTCDay() - cadence.weekday + 7) % 7;
  const candidate = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysBack, cadence.hourIst) - IST_OFFSET_MS);
  return candidate.getTime() <= now.getTime() ? candidate : new Date(candidate.getTime() - 7 * DAY_MS);
}

/** The next instant on the cadence strictly after `now`. */
export function nextSlot(cadence: Pick<PayoutBatchCadence, 'weekday' | 'hourIst'>, now: Date): Date {
  return new Date(lastSlot(cadence, now).getTime() + 7 * DAY_MS);
}

export type ScheduledDraft = {
  batch: BatchView;
  lineCount: number;
  totalNet: string;
  /** Whether draftable lines were left for the next draft because the cap was reached. */
  moreWaiting: boolean;
};

/**
 * One DRAFT from every draftable line, or nothing when there is none — a
 * draft with no lines would only be noise on a Monday morning. Audited
 * `PAYOUT_BATCH_DRAFTED_BY_SCHEDULE` against the batch with the system user
 * as the actor; the note on the batch says the same, so the desk can tell a
 * scheduled draft from one a person built.
 */
export async function draftScheduledBatch(actorId: string, now = new Date()): Promise<ScheduledDraft | null> {
  const candidates = await repository.findDraftableWithdrawals(SCHEDULE_DRAFT_MAX_LINES + 1);
  if (candidates.length === 0) return null;
  const lines = candidates.slice(0, SCHEDULE_DRAFT_MAX_LINES);
  const moreWaiting = candidates.length > lines.length;

  const stamp = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
  const created = await createBatch({ byUserId: actorId, note: `${SCHEDULE_NOTE_PREFIX} — ${stamp} IST` }, now);
  let batch: BatchView;
  try {
    batch = await setBatchLines(
      created.id,
      lines.map((row) => row.id),
      now,
    );
  } catch (err) {
    // A line that moved between the read and the attach refuses the whole
    // set; an empty draft is not left behind for a person to wonder about.
    await repository.updateBatch(created.id, { status: 'CANCELLED' });
    throw err;
  }

  await logActivity(actorId, 'PAYOUT_BATCH_DRAFTED_BY_SCHEDULE', {
    module: 'payouts',
    targetType: 'PayoutBatch',
    targetId: batch.id,
    diff: auditDiff({ status: null, lineCount: 0, totalNet: '0.00' }, { status: batch.status, lineCount: batch.lineCount, totalNet: money(batch.totalNet) }),
    metadata: { reference: batch.reference, rail: batch.rail, withdrawalIds: lines.map((row) => row.id), moreWaiting, scheduledAt: now.toISOString() },
  });

  return { batch: await getBatch(batch.id), lineCount: batch.lineCount, totalNet: money(batch.totalNet), moreWaiting };
}

export type PayoutBatchSchedule = PayoutBatchCadence & {
  /** The next instant the job will draft — null while the cadence is off. */
  nextRunAt: Date | null;
  /** The last draft the schedule built, if any. */
  lastDraft: { batchId: string; reference: string; status: string; lineCount: number; totalNet: string; createdAt: Date } | null;
};

/** GET /finance/payout-batches/schedule — the cadence as set, and what it will do next. */
export async function payoutBatchSchedule(now = new Date()): Promise<PayoutBatchSchedule> {
  const { finance } = await getPlatformSettings();
  const cadence = finance.payoutBatchCadence;
  const last = await repository.findLatestBatchByNote(SCHEDULE_NOTE_PREFIX);
  return {
    ...cadence,
    nextRunAt: cadence.enabled ? nextSlot(cadence, now) : null,
    lastDraft: last
      ? { batchId: last.id, reference: last.reference, status: last.status, lineCount: last.lineCount, totalNet: money(last.totalNet), createdAt: last.createdAt }
      : null,
  };
}
