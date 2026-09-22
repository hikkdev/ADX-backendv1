import type { Lead, LeadSequence, LeadSequenceRun } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { renderHtml, renderText } from '../notifications';
import { createSystemTask } from '../work';
import { isLeadChannel, LEAD_CHANNELS, MANUAL_CHANNELS, type LeadChannelValue } from './conversations.service';
import { prismaLeadsRepository as leads } from './prisma-leads.repository';
import { prismaOutreachRepository as repository } from './prisma-outreach.repository';
import type { NewSequence, SequencePatch, SequenceStep, SequenceWithCounts } from './outreach.repository';
import { channelLabel, registerSequenceStopPort, sendMessage } from './outreach.service';
import { isOpenStage, stageRank, type LeadStageValue } from './stages.rules';
import { registerLeadRecyclePort } from './stages.service';

/**
 * LH6: sequences — the scripted follow-up per side and temperature.
 *
 * A lead is enrolled when it is open, not yet ENGAGED, has a temperature
 * and is not already walking one; the active sequence for its side and
 * temperature is the one it walks. The tick sends each step when it is
 * due through the hub (`sendMessage`, source SEQUENCE — a step that cannot
 * go leaves a SKIPPED row and the run moves on), lands a "call them" task
 * for a CALL step, and stops the run when the steps run out, the lead
 * moves past CONTACTED, closes, changes temperature, or — the rule — when
 * ANY inbound arrives on ANY channel (`stopOnReply`, the hub's `engage`).
 */

const HOUR_MS = 60 * 60 * 1000;
const TICK_TAKE = 200;

export const STOP_REASONS = ['REPLIED', 'COMPLETED', 'STAGE_MOVED', 'CLOSED', 'TEMPERATURE_CHANGED', 'DEACTIVATED', 'MANUAL', 'NO_STEPS'] as const;

/** The sequence copy's channels: the ones the hub sends, plus CALL (a task). */
export const SEQUENCE_CHANNELS: readonly LeadChannelValue[] = LEAD_CHANNELS.filter((c) => !MANUAL_CHANNELS.includes(c));

export function readSteps(value: unknown): SequenceStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((step) => {
      const s = (step ?? {}) as { channel?: unknown; delayHours?: unknown; templateKey?: unknown };
      if (!isLeadChannel(s.channel) || !SEQUENCE_CHANNELS.includes(s.channel)) return null;
      const delayHours = typeof s.delayHours === 'number' && Number.isFinite(s.delayHours) ? Math.max(0, s.delayHours) : 0;
      return { channel: s.channel, delayHours, templateKey: typeof s.templateKey === 'string' && s.templateKey.trim() ? s.templateKey.trim() : null };
    })
    .filter((s): s is SequenceStep => s !== null);
}

/** D5's defaults, seeded once when the table is empty; the desk edits them after. */
export const DEFAULT_SEQUENCES: NewSequence[] = [
  { side: 'PUBLISHER', temperature: 'HOT', name: 'Publisher · hot', steps: [{ channel: 'CALL', delayHours: 0, templateKey: null }, { channel: 'WHATSAPP', delayHours: 2, templateKey: 'lead-seq-publisher-intro' }, { channel: 'SMS', delayHours: 24, templateKey: 'lead-seq-publisher-nudge' }], stopOnReply: true, isActive: true, createdById: null },
  { side: 'PUBLISHER', temperature: 'WARM', name: 'Publisher · warm', steps: [{ channel: 'WHATSAPP', delayHours: 1, templateKey: 'lead-seq-publisher-intro' }, { channel: 'EMAIL', delayHours: 48, templateKey: 'lead-seq-publisher-nudge' }, { channel: 'CALL', delayHours: 72, templateKey: null }, { channel: 'SMS', delayHours: 120, templateKey: 'lead-seq-last-call' }], stopOnReply: true, isActive: true, createdById: null },
  { side: 'PUBLISHER', temperature: 'COLD', name: 'Publisher · cold', steps: [{ channel: 'EMAIL', delayHours: 24, templateKey: 'lead-seq-publisher-intro' }, { channel: 'SMS', delayHours: 168, templateKey: 'lead-seq-publisher-nudge' }, { channel: 'WHATSAPP', delayHours: 336, templateKey: 'lead-seq-last-call' }], stopOnReply: true, isActive: true, createdById: null },
  { side: 'ADVERTISER', temperature: 'HOT', name: 'Advertiser · hot', steps: [{ channel: 'CALL', delayHours: 0, templateKey: null }, { channel: 'WHATSAPP', delayHours: 2, templateKey: 'lead-seq-advertiser-intro' }, { channel: 'EMAIL', delayHours: 24, templateKey: 'lead-seq-advertiser-nudge' }], stopOnReply: true, isActive: true, createdById: null },
  { side: 'ADVERTISER', temperature: 'WARM', name: 'Advertiser · warm', steps: [{ channel: 'EMAIL', delayHours: 1, templateKey: 'lead-seq-advertiser-intro' }, { channel: 'WHATSAPP', delayHours: 48, templateKey: 'lead-seq-advertiser-nudge' }, { channel: 'CALL', delayHours: 72, templateKey: null }, { channel: 'SMS', delayHours: 120, templateKey: 'lead-seq-last-call' }], stopOnReply: true, isActive: true, createdById: null },
  { side: 'ADVERTISER', temperature: 'COLD', name: 'Advertiser · cold', steps: [{ channel: 'EMAIL', delayHours: 24, templateKey: 'lead-seq-advertiser-intro' }, { channel: 'SMS', delayHours: 168, templateKey: 'lead-seq-advertiser-nudge' }, { channel: 'EMAIL', delayHours: 336, templateKey: 'lead-seq-last-call' }], stopOnReply: true, isActive: true, createdById: null },
];

export async function ensureDefaultSequences(): Promise<number> {
  if ((await repository.countSequences()) > 0) return 0;
  for (const seed of DEFAULT_SEQUENCES) await repository.createSequence(seed);
  return DEFAULT_SEQUENCES.length;
}

/* ── the desk's CRUD ─────────────────────────────────────────────── */

export function listSequences(filter: { side?: 'PUBLISHER' | 'ADVERTISER' | undefined; activeOnly?: boolean | undefined }): Promise<SequenceWithCounts[]> {
  return repository.listSequences(filter);
}

export async function getSequence(id: string): Promise<LeadSequence> {
  const row = await repository.findSequence(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such sequence');
  return row;
}

function assertSteps(steps: SequenceStep[]): void {
  if (steps.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'A sequence needs at least one step');
  for (const [i, step] of steps.entries()) {
    if (step.channel !== 'CALL' && !step.templateKey) throw new ApiError(400, 'VALIDATION_ERROR', `Step ${i + 1} (${channelLabel(step.channel)}) needs a template`, { step: i });
  }
}

export async function createSequence(input: NewSequence): Promise<LeadSequence> {
  assertSteps(input.steps);
  return repository.createSequence(input);
}

export async function updateSequence(id: string, patch: SequencePatch): Promise<{ before: LeadSequence; after: LeadSequence }> {
  const before = await getSequence(id);
  if (patch.steps) assertSteps(patch.steps);
  const after = await repository.updateSequence(id, patch);
  if (patch.isActive === false) {
    // Runs on a deactivated sequence stop at the next tick; nothing is sent in the meantime.
    logger.info('Sequence deactivated; its runs stop on the next tick', { sequenceId: id });
  }
  return { before, after };
}

/** The template's copy rendered with sample values — the editor's preview. */
export async function previewStep(templateKey: string): Promise<{ key: string; subject: string | null; short: string; email: string | null } | null> {
  const template = await leads.findCommsTemplate(templateKey);
  if (!template) return null;
  const sample = { contactName: 'Ravi', businessName: 'Sharma Stores', agentName: 'Asha', agentPhoneLine: ' · +91 98765 43210', link: 'https://adx.in/j/ABC123', city: 'Pune' };
  return {
    key: template.key,
    subject: template.subject ? renderText(template.subject, sample) : null,
    short: renderText(template.smsBody ?? template.pushBody ?? '', sample),
    email: template.emailBody ? renderHtml(template.emailBody, sample) : null,
  };
}

/* ── enrolment ───────────────────────────────────────────────────── */

const stepDue = (from: Date, step: SequenceStep): Date => new Date(from.getTime() + step.delayHours * HOUR_MS);

/** Enrol the lead in the active sequence for its side and temperature, when the rules say so. Answers the run, or null with why not. */
export async function enrol(leadId: string, options: { force?: boolean | undefined; sequenceId?: string | undefined; now?: Date | undefined } = {}): Promise<{ run: LeadSequenceRun | null; reason: string | null }> {
  const now = options.now ?? new Date();
  const lead = await leads.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  if (!isOpenStage(lead.stage as LeadStageValue)) return { run: null, reason: 'CLOSED' };
  if (!options.force && stageRank(lead.stage as LeadStageValue) >= stageRank('ENGAGED')) return { run: null, reason: 'ALREADY_ENGAGED' };
  const active = await repository.findActiveRun(leadId);
  if (active) {
    if (!options.force) return { run: active, reason: 'ALREADY_RUNNING' };
    await repository.updateRun(active.id, { stoppedAt: now, stopReason: 'MANUAL', nextAt: null });
  }
  const sequence = options.sequenceId ? await repository.findSequence(options.sequenceId) : lead.temperature ? await repository.findActiveSequence(lead.side, lead.temperature) : null;
  if (!sequence) return { run: null, reason: lead.temperature ? 'NO_SEQUENCE' : 'NO_TEMPERATURE' };
  if (!sequence.isActive) return { run: null, reason: 'SEQUENCE_INACTIVE' };
  const steps = readSteps(sequence.steps);
  if (steps.length === 0) return { run: null, reason: 'NO_STEPS' };
  const run = await repository.createRun({ leadId, sequenceId: sequence.id, stepIndex: 0, nextAt: stepDue(now, steps[0]!), startedAt: now });
  await leads.logActivity({ leadId, actorUserId: null, kind: 'NOTE', note: `Enrolled in "${sequence.name}" (${steps.length} step${steps.length === 1 ? '' : 's'})` });
  return { run, reason: null };
}

export async function stopFor(leadId: string, reason: string, at = new Date()): Promise<number> {
  return repository.stopRuns(leadId, at, reason);
}

/**
 * LH11: the recycle's own hook — a lead that comes back to the cold pool
 * after sixty days starts a **fresh** run of its side's sequence, whatever
 * it had before (`force`), because the point of the recycle is that the
 * conversation starts again. Registered on the stages module's port from
 * the module's index, so the pipeline job needs no import of this file.
 */
export function registerRecycleSequencing(): void {
  registerLeadRecyclePort({
    onRecycled: async (leadId: string) => {
      const { reason } = await enrol(leadId, { force: true });
      if (reason) logger.info('A recycled lead took no sequence', { leadId, reason });
    },
  });
}

/** The temperature hook: a lead that changes temperature leaves its sequence and, when it is still to be worked, joins the new one. */
export async function onTemperature(leadId: string, to: 'HOT' | 'WARM' | 'COLD', from: 'HOT' | 'WARM' | 'COLD' | null, now = new Date()): Promise<void> {
  if (from === to) return;
  if (from !== null) await stopFor(leadId, 'TEMPERATURE_CHANGED', now);
  await enrol(leadId, { now }).catch((err) => logger.warn('Sequence enrolment failed', { leadId, err }));
}

export function runView(run: (LeadSequenceRun & { sequence: LeadSequence }) | null) {
  if (!run) return null;
  const steps = readSteps(run.sequence.steps);
  return {
    id: run.id,
    sequenceId: run.sequenceId,
    sequenceName: run.sequence.name,
    stepIndex: run.stepIndex,
    steps: steps.length,
    nextStep: run.stoppedAt ? null : (steps[run.stepIndex] ?? null),
    nextAt: run.nextAt?.toISOString() ?? null,
    startedAt: run.startedAt.toISOString(),
    stoppedAt: run.stoppedAt?.toISOString() ?? null,
    stopReason: run.stopReason,
  };
}

export async function runsFor(leadId: string) {
  const runs = await repository.listRuns(leadId);
  return runs.map(runView);
}

/* ── the tick ────────────────────────────────────────────────────── */

async function holderUser(lead: Lead): Promise<string | null> {
  const holder = lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > new Date() ? lead.claimedByAgentId : lead.assignedAgentId;
  if (!holder) return null;
  const agent = await repository.findAgentUser(holder);
  return agent?.userId ?? null;
}

/** One due run: send or task the step, then advance or stop. */
async function runStep(run: LeadSequenceRun & { sequence: LeadSequence; lead: Lead }, now: Date): Promise<'SENT' | 'QUEUED' | 'SKIPPED' | 'TASKED' | 'STOPPED'> {
  const lead = run.lead;
  const stage = lead.stage as LeadStageValue;
  if (!isOpenStage(stage)) {
    await repository.updateRun(run.id, { stoppedAt: now, stopReason: 'CLOSED', nextAt: null });
    return 'STOPPED';
  }
  if (stageRank(stage) >= stageRank('ENGAGED')) {
    await repository.updateRun(run.id, { stoppedAt: now, stopReason: 'STAGE_MOVED', nextAt: null });
    return 'STOPPED';
  }
  if (!run.sequence.isActive) {
    await repository.updateRun(run.id, { stoppedAt: now, stopReason: 'DEACTIVATED', nextAt: null });
    return 'STOPPED';
  }
  const steps = readSteps(run.sequence.steps);
  const step = steps[run.stepIndex];
  if (!step) {
    await repository.updateRun(run.id, { stoppedAt: now, stopReason: 'COMPLETED', nextAt: null });
    return 'STOPPED';
  }

  let result: 'SENT' | 'QUEUED' | 'SKIPPED' | 'TASKED';
  if (step.channel === 'CALL') {
    const userId = await holderUser(lead);
    await createSystemTask({ title: `Call ${lead.businessName}`, description: `Step ${run.stepIndex + 1} of "${run.sequence.name}"${lead.phone ? ` · ${lead.phone}` : ''}`, linkedKind: 'LEAD', linkedId: lead.id, assigneeUserIds: userId ? [userId] : [], deadline: new Date(now.getTime() + 24 * HOUR_MS), priority: 'HIGH', tag: 'call' }, now).catch((err) => logger.warn('Call step task not created', { leadId: lead.id, err }));
    result = 'TASKED';
  } else {
    const outcome = await sendMessage({ leadId: lead.id, channel: step.channel, templateKey: step.templateKey ?? undefined, actor: { userId: null, agentId: lead.assignedAgentId }, source: 'SEQUENCE', sequenceRunId: run.id }, now);
    result = outcome.outcome;
  }

  const nextIndex = run.stepIndex + 1;
  const next = steps[nextIndex];
  if (!next) await repository.updateRun(run.id, { stepIndex: nextIndex, stoppedAt: now, stopReason: 'COMPLETED', nextAt: null });
  else await repository.updateRun(run.id, { stepIndex: nextIndex, nextAt: stepDue(now, next) });
  return result;
}

export async function tickSequences(now = new Date()): Promise<{ picked: number; sent: number; queued: number; skipped: number; tasked: number; stopped: number }> {
  const due = await repository.dueRuns(now, TICK_TAKE);
  const counts = { picked: due.length, sent: 0, queued: 0, skipped: 0, tasked: 0, stopped: 0 };
  for (const run of due) {
    try {
      const result = await runStep(run, now);
      if (result === 'SENT') counts.sent += 1;
      else if (result === 'QUEUED') counts.queued += 1;
      else if (result === 'SKIPPED') counts.skipped += 1;
      else if (result === 'TASKED') counts.tasked += 1;
      else counts.stopped += 1;
    } catch (err) {
      logger.warn('Sequence step failed; it will be retried next tick', { runId: run.id, err });
    }
  }
  return counts;
}

// The hub stops runs on any inbound through this port, so it never imports this file.
registerSequenceStopPort((leadId, reason, at) => stopFor(leadId, reason, at));
