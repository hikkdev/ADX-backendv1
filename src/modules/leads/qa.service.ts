import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { prismaIntegrityRepository as repository } from './prisma-integrity.repository';
import { distanceM } from './prisma-leads.repository';
import type { CallSample, VisitSample } from './integrity.repository';

/**
 * LH10 (the Lead Hunt, quality) — QA sampling.
 *
 * A share of yesterday's field work is drawn every night and checked against
 * the evidence it should carry:
 *
 * - a **visit** should have a photo and a fix taken where the visit was —
 *   `PROOF_RADIUS_M` of the site when the site has coordinates;
 * - a **call** the platform recorded should carry the consent line and a
 *   recording, and last long enough to have been a conversation.
 *
 * The auto verdict is what the evidence alone says. It is not a judgement:
 * ops review a sample and may overrule it, and the agent's **quality score**
 * is the share of reviewed-or-auto PASSes over ninety days, with confirmed
 * integrity flags (LH10's scan) counted against it. Nothing here pays or
 * withholds money — the score is a number ops read beside the rating.
 */

/** One in this many completed visits is drawn, at least one a night where there is any. */
export const VISIT_SAMPLE_RATE = 5;
/** One in this many recorded calls. */
export const CALL_SAMPLE_RATE = 10;
/** A proof fix further than this from the site fails the visit's evidence check. */
export const PROOF_RADIUS_M = 300;
/** A call shorter than this was not a conversation. */
export const MIN_CALL_SEC = 20;
/** The window the quality score reads. */
export const QUALITY_WINDOW_DAYS = 90;
/** A confirmed flag costs this much of the score, and never more than half of it in all. */
export const FLAG_PENALTY = 0.1;
export const MAX_FLAG_PENALTY = 0.5;
/** Below this many samples the score is null: a score off two visits is not a score. */
export const MIN_QUALITY_SAMPLE = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export type VisitEvidence = { photo: boolean; gps: boolean; metres: number | null; site: boolean };
export type CallEvidence = { recording: boolean; consent: boolean; durationSec: number | null; outcome: string | null };

/** What a visit's evidence says, and whether it passes. Pure. */
export function readVisitEvidence(visit: VisitSample): { evidence: VisitEvidence; verdict: 'PASS' | 'FAIL' } {
  const photo = visit.proofFileId !== null;
  const gps = visit.proofLatitude !== null && visit.proofLongitude !== null;
  const site = visit.latitude !== null && visit.longitude !== null;
  const metres =
    gps && site
      ? distanceM({ latitude: visit.proofLatitude as number, longitude: visit.proofLongitude as number }, { latitude: visit.latitude, longitude: visit.longitude })
      : null;
  const evidence: VisitEvidence = { photo, gps, metres, site };
  // A site with no coordinates cannot fail the distance test — the photo and
  // the fix are still asked for.
  const near = metres === null || metres <= PROOF_RADIUS_M;
  return { evidence, verdict: photo && gps && near ? 'PASS' : 'FAIL' };
}

/** What a recorded call's evidence says. Pure. */
export function readCallEvidence(call: CallSample): { evidence: CallEvidence; verdict: 'PASS' | 'FAIL' } {
  const evidence: CallEvidence = {
    recording: call.recordingFileId !== null,
    consent: call.consentPlayed === true,
    durationSec: call.durationSec,
    outcome: call.outcome,
  };
  // A recording kept without the consent line is the failure that matters
  // (D5: the line gates the recording); a call nobody recorded is judged on
  // whether it was long enough to have happened.
  if (evidence.recording && !evidence.consent) return { evidence, verdict: 'FAIL' };
  const longEnough = (call.durationSec ?? 0) >= MIN_CALL_SEC;
  const answered = call.outcome === 'ANSWERED' || call.outcome === null;
  return { evidence, verdict: !answered || longEnough ? 'PASS' : 'FAIL' };
}

/** Every nth row, the first always taken — a deterministic sample, so a re-run draws the same work. */
export const everyNth = <T>(rows: readonly T[], n: number): T[] => rows.filter((_, index) => index % n === 0);

/**
 * The nightly draw: yesterday's completed visits and recorded calls, one in
 * `VISIT_SAMPLE_RATE` / `CALL_SAMPLE_RATE`, each stored once.
 */
export async function sampleQa(now = new Date()): Promise<{ visits: number; calls: number; failed: number }> {
  const to = now;
  const from = new Date(now.getTime() - DAY_MS);
  let visits = 0;
  let calls = 0;
  let failed = 0;

  try {
    const rows = await repository.visitsCompletedBetween(from, to, 500);
    for (const visit of everyNth(rows, VISIT_SAMPLE_RATE)) {
      if (await repository.qaSampleExists('VISIT', visit.id)) continue;
      const { evidence, verdict } = readVisitEvidence(visit);
      await repository.createQaSample({ kind: 'VISIT', agentId: visit.agentId, visitId: visit.id, leadId: visit.leadId, evidence, autoVerdict: verdict, sampledAt: now });
      visits += 1;
      if (verdict === 'FAIL') failed += 1;
    }
  } catch (err) {
    logger.warn('The visit QA draw failed', { err });
  }

  try {
    const rows = await repository.callsBetween(from, to, 500);
    for (const call of everyNth(rows, CALL_SAMPLE_RATE)) {
      if (!call.byAgentId) continue;
      if (await repository.qaSampleExists('CALL', call.id)) continue;
      const { evidence, verdict } = readCallEvidence(call);
      await repository.createQaSample({ kind: 'CALL', agentId: call.byAgentId, messageId: call.id, leadId: call.leadId, evidence, autoVerdict: verdict, sampledAt: now });
      calls += 1;
      if (verdict === 'FAIL') failed += 1;
    }
  } catch (err) {
    logger.warn('The call QA draw failed', { err });
  }

  return { visits, calls, failed };
}

/* ── the desk ─────────────────────────────────────────────────────── */

export type QaSampleView = {
  id: string;
  kind: string;
  agentId: string;
  visitId: string | null;
  messageId: string | null;
  leadId: string | null;
  evidence: unknown;
  autoVerdict: string;
  verdict: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  note: string | null;
  sampledAt: string;
};

type QaRow = {
  id: string;
  kind: string;
  agentId: string;
  visitId: string | null;
  messageId: string | null;
  leadId: string | null;
  evidence: unknown;
  autoVerdict: string;
  verdict: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  note: string | null;
  sampledAt: Date;
};

export const qaSampleView = (row: QaRow): QaSampleView => ({
  id: row.id,
  kind: row.kind,
  agentId: row.agentId,
  visitId: row.visitId,
  messageId: row.messageId,
  leadId: row.leadId,
  evidence: row.evidence ?? null,
  autoVerdict: row.autoVerdict,
  verdict: row.verdict,
  reviewedByUserId: row.reviewedByUserId,
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
  note: row.note,
  sampledAt: row.sampledAt.toISOString(),
});

export async function listQaSamples(filter: { agentId?: string | undefined; kind?: string | undefined; reviewed?: boolean | undefined; limit?: number | undefined }) {
  const rows = await repository.listQaSamples({ agentId: filter.agentId, kind: filter.kind, reviewed: filter.reviewed, limit: Math.min(filter.limit ?? 100, 200) });
  return { items: rows.map((row) => qaSampleView(row as QaRow)), total: rows.length };
}

/** Ops looked: the verdict, and the note that explains an overrule. Audited by the caller. */
export async function reviewQaSample(sampleId: string, input: { verdict: 'PASS' | 'FAIL'; note?: string | undefined }, actorUserId: string, now = new Date()): Promise<QaSampleView> {
  const sample = await repository.findQaSample(sampleId);
  if (!sample) throw new ApiError(404, 'NOT_FOUND', 'No such sample');
  const row = sample as unknown as QaRow;
  if (input.verdict !== row.autoVerdict && !input.note?.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the evidence reads differently to you');
  }
  const after = await repository.updateQaSample(sampleId, { verdict: input.verdict, reviewedByUserId: actorUserId, reviewedAt: now, note: input.note?.trim() || null });
  await logActivity(actorUserId, 'LEAD_QA_REVIEWED', undefined, { sampleId, kind: row.kind, agentId: row.agentId, autoVerdict: row.autoVerdict, verdict: input.verdict });
  return qaSampleView(after as unknown as QaRow);
}

/* ── the quality score ────────────────────────────────────────────── */

export type QualityScore = {
  /** 0–1 to two places, or null under the floor. */
  score: string | null;
  samples: number;
  passed: number;
  failed: number;
  /** How many of the samples a person has looked at. */
  reviewed: number;
  visits: number;
  calls: number;
  confirmedFlags: number;
  /** What the flags took off, as a share. */
  flagPenalty: string;
  windowDays: number;
  minimumSample: number;
};

/**
 * The agent's quality score: the share of PASSes over the window (a reviewed
 * verdict wins over the automatic one), less `FLAG_PENALTY` per confirmed
 * integrity flag, floored at 0 and never docked more than `MAX_FLAG_PENALTY`.
 * Null under `MIN_QUALITY_SAMPLE` samples — the same honesty the rating
 * keeps: too little history is no score, not a bad one.
 */
export async function qualityFor(agentId: string, now = new Date()): Promise<QualityScore> {
  const since = new Date(now.getTime() - QUALITY_WINDOW_DAYS * DAY_MS);
  const [samples, confirmedFlags] = await Promise.all([repository.qaSamplesForAgent(agentId, since), repository.confirmedFlagsForAgent(agentId, since)]);
  const verdicts = samples.map((sample) => ({ kind: sample.kind as string, verdict: (sample.verdict ?? sample.autoVerdict) as string, reviewed: sample.verdict !== null }));
  const passed = verdicts.filter((row) => row.verdict === 'PASS').length;
  const failed = verdicts.length - passed;
  const penalty = Math.min(MAX_FLAG_PENALTY, confirmedFlags * FLAG_PENALTY);
  const share = verdicts.length === 0 ? 0 : passed / verdicts.length;
  const score = verdicts.length < MIN_QUALITY_SAMPLE ? null : Math.max(0, Math.round((share - penalty) * 100) / 100).toFixed(2);
  return {
    score,
    samples: verdicts.length,
    passed,
    failed,
    reviewed: verdicts.filter((row) => row.reviewed).length,
    visits: verdicts.filter((row) => row.kind === 'VISIT').length,
    calls: verdicts.filter((row) => row.kind === 'CALL').length,
    confirmedFlags,
    flagPenalty: penalty.toFixed(2),
    windowDays: QUALITY_WINDOW_DAYS,
    minimumSample: MIN_QUALITY_SAMPLE,
  };
}
