import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import {
  addEvidenceSchema,
  addNoteSchema,
  decideCaseSchema,
  escalateCaseSchema,
  listCasesQuerySchema,
  openCaseSchema,
  patchCaseSchema,
  scanParamsSchema,
} from './fraud.schema';
import { addEvidence, addNote, DECIDED_ACTION, decideCase, escalateCase, getCase, listCases, openCase, patchCase, type Actor } from './fraud.service';
import { linkedAccounts, scanSubject, scoreCase } from './fraud-signals.service';

const actorOf = (req: Request): Actor => ({ sub: req.user!.sub, roles: req.user!.roles ?? [] });
const caseId = (req: Request) => req.params['caseId'] as string;

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

/*
 * Every write here is an ADMIN write on a case that may end in a suspension,
 * so each is audited by hand with the case as the target — FRAUD_CASE_* —
 * and the decision row carries `scopesApplied`, which a later dismissal
 * reads back to know what to lift.
 */

export async function listHandler(req: Request, res: Response): Promise<void> {
  const parsed = listCasesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listCases(parsed.data) });
}

export async function openHandler(req: Request, res: Response): Promise<void> {
  const parsed = openCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const created = await openCase(actor, parsed.data);
  await logActivity(actor.sub, 'FRAUD_CASE_OPENED', {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: created.id,
    metadata: {
      caseId: created.id,
      displayId: created.displayId,
      subjectType: created.subjectType,
      subjectId: created.subjectId,
      kind: created.kind,
      disputeId: created.disputeId,
    },
  });
  res.status(201).json({ success: true, data: created });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getCase(caseId(req)) });
}

export async function noteHandler(req: Request, res: Response): Promise<void> {
  const parsed = addNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const note = await addNote(caseId(req), actor, parsed.data.body);
  await logActivity(actor.sub, 'FRAUD_CASE_NOTE_ADDED', {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: caseId(req),
    metadata: { caseId: caseId(req), noteId: note.id },
  });
  res.status(201).json({ success: true, data: note });
}

export async function evidenceHandler(req: Request, res: Response): Promise<void> {
  const parsed = addEvidenceSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const evidence = await addEvidence(caseId(req), actor, parsed.data);
  await logActivity(actor.sub, 'FRAUD_CASE_EVIDENCE_ADDED', {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: caseId(req),
    metadata: { caseId: caseId(req), evidenceId: evidence.id, kind: evidence.kind },
  });
  res.status(201).json({ success: true, data: evidence });
}

export async function patchHandler(req: Request, res: Response): Promise<void> {
  const parsed = patchCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const { before, after } = await patchCase(caseId(req), actor, parsed.data);
  await logActivity(actor.sub, 'FRAUD_CASE_UPDATED', {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: after.id,
    diff: auditDiff(before, after, ['status', 'assignedToUserId']),
    metadata: { caseId: after.id },
  });
  res.json({ success: true, data: after });
}

export async function decideHandler(req: Request, res: Response): Promise<void> {
  const parsed = decideCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const { before, after, scopesApplied, scopesLifted } = await decideCase(caseId(req), actor, parsed.data);
  await logActivity(actor.sub, DECIDED_ACTION, {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: after.id,
    diff: auditDiff(before, after, ['status', 'decision', 'decidedByUserId', 'decidedAt']),
    metadata: {
      caseId: after.id,
      displayId: after.displayId,
      status: after.status,
      subjectType: after.subjectType,
      subjectId: after.subjectId,
      scopesRequested: parsed.data.scopes ?? null,
      scopesApplied,
      scopesLifted,
    },
  });
  res.json({ success: true, data: { ...after, scopesApplied, scopesLifted } });
}

/* ── Lot G (Q118/138): the score, the scan, the links, the escalation ──────── */

/** The model name a scan is audited against, as every other desk names its target. */
const SUBJECT_MODEL = { LISTING: 'Listing', PUBLISHER: 'Publisher', ADVERTISER: 'Advertiser', AGENT: 'AgentProfile' } as const;

// POST /fraud/cases/:caseId/score — recomputed and stored; audited with the score's move.
export async function scoreHandler(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const { before, after } = await scoreCase(caseId(req), actor);
  await logActivity(actor.sub, 'FRAUD_CASE_SCORED', {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: after.id,
    diff: auditDiff(before, after, ['score', 'scoredAt']),
    metadata: { caseId: after.id, score: after.score === null ? null : String(after.score), signals: (after.signals as { key: string; value: number | null }[] | null)?.map((s) => ({ key: s.key, value: s.value })) ?? null },
  });
  res.json({ success: true, data: after });
}

// POST /fraud/scan/:subjectType/:subjectId — evaluated, stored nowhere; the read is still audited: it names a party.
export async function scanHandler(req: Request, res: Response): Promise<void> {
  const parsed = scanParamsSchema.safeParse(req.params);
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const result = await scanSubject(parsed.data.subjectType, parsed.data.subjectId);
  await logActivity(actor.sub, 'FRAUD_SUBJECT_SCANNED', {
    req,
    module: 'fraud',
    targetType: SUBJECT_MODEL[parsed.data.subjectType],
    targetId: parsed.data.subjectId,
    metadata: { score: result.score, hot: result.signals.filter((s) => s.value !== null && s.value > 0).map((s) => s.key) },
  });
  res.json({ success: true, data: result });
}

// GET /fraud/cases/:caseId/linked
export async function linkedHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await linkedAccounts(caseId(req)) });
}

// POST /fraud/cases/:caseId/escalate
export async function escalateHandler(req: Request, res: Response): Promise<void> {
  const parsed = escalateCaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const actor = actorOf(req);
  const { before, after } = await escalateCase(caseId(req), actor, parsed.data);
  await logActivity(actor.sub, 'FRAUD_CASE_ESCALATED', {
    req,
    module: 'fraud',
    targetType: 'FraudCase',
    targetId: after.id,
    diff: auditDiff(before, after, ['status', 'escalatedAt', 'escalatedToUserId']),
    metadata: { caseId: after.id, displayId: after.displayId, note: parsed.data.note, escalatedToUserId: after.escalatedToUserId },
  });
  res.json({ success: true, data: after });
}
