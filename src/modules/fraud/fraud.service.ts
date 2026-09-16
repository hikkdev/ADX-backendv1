import type { FraudCase, SuspensionScope } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { allocateIdentifier } from '../identifiers';
import { escalateKycForFraudLink } from '../kyc';
import { logger } from '../../shared/logging';
import { createNotification } from '../notifications';
import { reinstateParty, SCOPES_BY_PARTY, suspendParty, suspensionOf, type PartyType } from '../suspension';
import { findUserLabels, userExists } from '../users';
import { prismaFraudRepository as repository } from './prisma-fraud.repository';
import type { NewFraudCase, OpenFraudCaseRef } from './fraud.repository';
import {
  DEFAULT_CONFIRMED_SCOPES,
  SUSPENSION_SCOPES,
  type AddEvidenceInput,
  type DecideCaseInput,
  type EscalateCaseInput,
  type ListCasesQuery,
  type OpenCaseInput,
  type PatchCaseInput,
} from './fraud.schema';

/**
 * Fraud cases — Lot D (Q54/Q92/Q121).
 *
 * Fraud is a case object, not a flag on a dispute: the place that records
 * which party, on what evidence, who looked, and what was done. A decision
 * is the only thing here that touches the party, and it does so through the
 * suspension module — a CONFIRMED case applies scopes with the case number
 * as the reason (BLOCK_NEW + FREEZE_WALLET by default; the wallet freeze IS
 * the FREEZE_WALLET scope, decision 121), and a DISMISSED case lifts exactly
 * what this case applied and nothing the party was carrying before it.
 *
 * Which scopes a case applied is on the row — `FraudCase.appliedScopes`
 * (Lot E; E6 moved the read off the audit trail) — written by the
 * confirmation and read by the overturn. The controller still writes the
 * `FRAUD_CASE_DECIDED` audit row with the same list, so the trail keeps it
 * too; the row is simply the record the decision consults.
 *
 * The case number is `identifiers`' FRAUD_CASE series (FRD-…), minted like
 * every other desk's rather than through a per-year count of its own.
 */

export type Actor = { sub: string; roles: string[] };

/** The audit action the controller writes on a decision; the dismissal reads it back. */
export const DECIDED_ACTION = 'FRAUD_CASE_DECIDED';

const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');
const isDecided = (status: string) => status === 'CONFIRMED' || status === 'DISMISSED';

async function requireOpenCase(caseId: string) {
  const fraudCase = await repository.findSummaryById(caseId);
  if (!fraudCase) throw new ApiError(404, 'NOT_FOUND', 'Fraud case not found');
  if (isDecided(fraudCase.status)) throw new ApiError(409, 'CONFLICT', 'This case has been decided');
  return fraudCase;
}

/* ── G11-1: the people on a case by name ─────────────────────────────────── */

export type CasePerson = { id: string; name: string | null };
type CasePeopleIds = Pick<FraudCase, 'openedByUserId' | 'assignedToUserId' | 'decidedByUserId' | 'escalatedToUserId'>;
export type CasePeople = { openedBy: CasePerson | null; assignedTo: CasePerson | null; decidedBy: CasePerson | null; escalatedTo: CasePerson | null };

/**
 * `openedBy` / `assignedTo` / `decidedBy` / `escalatedTo` as `{ id, name }`
 * beside the ids, for a page of rows or one case — one `users.findUserLabels`
 * lookup per read. A name is decoration on the case: with the lookup failing,
 * every person is `{ id, name: null }` and the case still answers.
 */
async function withPeople<T extends CasePeopleIds>(rows: T[]): Promise<(T & CasePeople)[]> {
  const ids = [...new Set(rows.flatMap((row) => [row.openedByUserId, row.assignedToUserId, row.decidedByUserId, row.escalatedToUserId]).filter((id): id is string => !!id))];
  let labels = new Map<string, CasePerson>();
  if (ids.length > 0) {
    try {
      labels = await findUserLabels(ids);
    } catch {
      // Names null; the case answers.
    }
  }
  const label = (id: string | null): CasePerson | null => (id ? labels.get(id) ?? { id, name: null } : null);
  return rows.map((row) => ({
    ...row,
    openedBy: label(row.openedByUserId),
    assignedTo: label(row.assignedToUserId),
    decidedBy: label(row.decidedByUserId),
    escalatedTo: label(row.escalatedToUserId),
  }));
}

export async function listCases(query: ListCasesQuery) {
  const page = await repository.list(query);
  // G11-1: the people on every row by name, one lookup for the page.
  return { ...page, items: await withPeople(page.items) };
}

/** Opens a case against a party that exists — the suspension read is the existence check, and 404s for us. */
export async function openCase(admin: Actor, input: OpenCaseInput, now = new Date()) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX opens a fraud case');
  await suspensionOf(input.subjectType, input.subjectId);
  if (input.assignedToUserId && !(await userExists(input.assignedToUserId))) {
    throw new ApiError(404, 'NOT_FOUND', 'That admin user does not exist');
  }
  const created = await openCaseRecord(
    {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind,
      summary: input.summary,
      openedByUserId: admin.sub,
      assignedToUserId: input.assignedToUserId ?? null,
      disputeId: input.disputeId ?? null,
    },
    now,
  );
  if (created.assignedToUserId && created.assignedToUserId !== admin.sub) {
    await tell(created.assignedToUserId, created, 'Fraud case assigned to you', created.summary);
  }
  return created;
}

/**
 * The insert every opener shares — the desk's `openCase` and the nightly
 * scan: the FRD- number minted through `identifiers`, the row written, and
 * (Lot G, Q127/142) `kyc` told so a PENDING KYC on the same party is
 * escalated as FRAUD_LINK. The KYC side never fails the open.
 */
export async function openCaseRecord(data: Omit<NewFraudCase, 'displayId'>, now = new Date()): Promise<FraudCase> {
  const created = await repository.create({ ...data, displayId: await allocateIdentifier('FRAUD_CASE', now) }, now);
  try {
    await escalateKycForFraudLink({
      subjectType: created.subjectType,
      subjectId: created.subjectId,
      caseDisplayId: created.displayId ?? created.id,
      byUserId: created.openedByUserId,
    });
  } catch (err) {
    logger.warn('Fraud case opened but the KYC link escalation failed', { caseId: created.id, reason: err instanceof Error ? err.message : String(err) });
  }
  return created;
}

/** The case file: the case, its notes, its evidence, and where the subject stands today. */
export async function getCase(caseId: string) {
  const file = await repository.findById(caseId);
  if (!file) throw new ApiError(404, 'NOT_FOUND', 'Fraud case not found');
  // G11-1: the four people by name beside their ids, one lookup.
  const [named] = await withPeople([file]);
  const suspension = await suspensionOf(file.subjectType, file.subjectId).catch(() => null);
  return {
    ...named!,
    suspension: suspension
      ? {
          name: suspension.name,
          scopes: suspension.scopes,
          suspendedAt: suspension.suspendedAt,
          suspensionReason: suspension.suspensionReason,
          suspendedById: suspension.suspendedById,
        }
      : null,
  };
}

export async function addNote(caseId: string, admin: Actor, body: string) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX works a fraud case');
  await requireOpenCase(caseId);
  return repository.addNote({ caseId, byUserId: admin.sub, body });
}

export async function addEvidence(caseId: string, admin: Actor, input: AddEvidenceInput) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX works a fraud case');
  if (input.fileId === undefined && input.url === undefined && input.note === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Evidence points at a file, a link or a note');
  }
  await requireOpenCase(caseId);
  return repository.addEvidence({
    caseId,
    kind: input.kind,
    fileId: input.fileId ?? null,
    url: input.url ?? null,
    note: input.note ?? null,
    addedByUserId: admin.sub,
  });
}

/** Working the case: INVESTIGATING, and who is on it. Returns before and after for the audit diff. */
export async function patchCase(caseId: string, admin: Actor, input: PatchCaseInput) {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX works a fraud case');
  const before = await requireOpenCase(caseId);
  const patch: { status?: 'INVESTIGATING'; assignedToUserId?: string | null } = {};
  if (input.status !== undefined && input.status !== before.status) patch.status = input.status;
  if (input.assignedToUserId !== undefined && input.assignedToUserId !== before.assignedToUserId) {
    if (input.assignedToUserId && !(await userExists(input.assignedToUserId))) {
      throw new ApiError(404, 'NOT_FOUND', 'That admin user does not exist');
    }
    patch.assignedToUserId = input.assignedToUserId;
  }
  const after = Object.keys(patch).length > 0 ? await repository.update(caseId, patch) : before;
  if (patch.assignedToUserId && patch.assignedToUserId !== admin.sub) {
    await tell(patch.assignedToUserId, after, 'Fraud case assigned to you', after.summary);
  }
  return { before, after };
}

/**
 * Lot G (Q118): the case handed up. Still open — notes, evidence and the
 * decision all continue — but marked, timed and (when named) given to
 * someone, who hears about it. Once is enough; a decided case is not
 * escalated.
 */
export async function escalateCase(caseId: string, admin: Actor, input: EscalateCaseInput, now = new Date()): Promise<{ before: FraudCase; after: FraudCase }> {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX escalates a fraud case');
  const before = await requireOpenCase(caseId);
  if (before.status === 'ESCALATED') throw new ApiError(409, 'CONFLICT', 'This case is already escalated');
  if (input.toUserId && !(await userExists(input.toUserId))) {
    throw new ApiError(404, 'NOT_FOUND', 'That admin user does not exist');
  }
  const escalatedToUserId = input.toUserId ?? before.assignedToUserId ?? null;
  const after = await repository.update(caseId, {
    status: 'ESCALATED',
    escalatedAt: now,
    escalatedToUserId,
    escalationNote: input.note,
  });
  if (escalatedToUserId && escalatedToUserId !== admin.sub) {
    await tell(escalatedToUserId, after, 'Fraud case escalated to you', input.note);
  }
  return { before, after };
}

export type Decision = {
  before: FraudCase;
  after: FraudCase;
  scopesApplied: string[];
  scopesLifted: string[];
};

/**
 * The decision.
 *
 * CONFIRMED suspends the subject on the scopes named (the default pair when
 * none are), filtered to what the party's type admits and to what it is not
 * already carrying — so `scopesApplied` is exactly what this case did, and
 * what a later dismissal lifts. DISMISSED on an open case does nothing to
 * the party; DISMISSED on a CONFIRMED case is an overturn and lifts what the
 * confirmation applied. A case is decided once in each direction: a
 * confirmation cannot be repeated, a dismissal is final.
 */
export async function decideCase(caseId: string, admin: Actor, input: DecideCaseInput, now = new Date()): Promise<Decision> {
  if (!isAdmin(admin)) throw new ApiError(403, 'FORBIDDEN', 'Only ADX decides a fraud case');
  const before = await repository.findSummaryById(caseId);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Fraud case not found');
  if (before.status === 'DISMISSED') throw new ApiError(409, 'CONFLICT', 'This case was dismissed; open a new one');
  if (before.status === 'CONFIRMED' && input.status === 'CONFIRMED') {
    throw new ApiError(409, 'CONFLICT', 'This case is already confirmed');
  }

  const partyType = before.subjectType as PartyType;
  const reason = `Fraud case ${before.displayId ?? before.id}`;
  let scopesApplied: SuspensionScope[] = [];
  let scopesLifted: SuspensionScope[] = [];

  if (input.status === 'CONFIRMED') {
    const current = await suspensionOf(partyType, before.subjectId);
    const admitted = SCOPES_BY_PARTY[partyType];
    const requested = (input.scopes ?? [...DEFAULT_CONFIRMED_SCOPES]).filter((scope) => admitted.includes(scope));
    const scopes = requested.filter((scope) => !current.scopes.includes(scope));
    if (scopes.length > 0) {
      await suspendParty(partyType, before.subjectId, { scopes, reason, byUserId: admin.sub });
      scopesApplied = scopes;
    }
  } else if (before.status === 'CONFIRMED') {
    // E6: what the confirmation applied is on the row.
    const applied = scopesAppliedBy(before);
    if (applied.length > 0) {
      await reinstateParty(partyType, before.subjectId, { scopes: applied, reason: `${reason} dismissed`, byUserId: admin.sub });
      scopesLifted = applied;
    }
  }

  const after = await repository.update(caseId, {
    status: input.status,
    decision: input.decision,
    decidedByUserId: admin.sub,
    decidedAt: now,
    // E6: CONFIRMED records what it did; DISMISSED leaves the list as the history of what was lifted.
    ...(input.status === 'CONFIRMED' ? { appliedScopes: scopesApplied } : {}),
  });

  const title = input.status === 'CONFIRMED' ? 'Fraud case confirmed' : 'Fraud case dismissed';
  const people = [before.openedByUserId, before.assignedToUserId].filter((id): id is string => !!id && id !== admin.sub);
  await Promise.all([...new Set(people)].map((userId) => tell(userId, after, title, input.decision)));

  return { before, after, scopesApplied, scopesLifted };
}

/** What the confirmation of this case applied — `appliedScopes` on the row, filtered to the scopes we know. */
function scopesAppliedBy(fraudCase: Pick<FraudCase, 'appliedScopes'>): SuspensionScope[] {
  const known: readonly string[] = SUSPENSION_SCOPES;
  return (fraudCase.appliedScopes ?? []).filter((scope): scope is SuspensionScope => typeof scope === 'string' && known.includes(scope));
}

/** Used by `disputes`: the open case citing each dispute, for the case card's "Open fraud case" line. */
export async function findOpenFraudCasesForDisputes(disputeIds: string[]): Promise<OpenFraudCaseRef[]> {
  return repository.findOpenForDisputes(disputeIds);
}

function tell(userId: string, fraudCase: { id: string; displayId: string | null }, title: string, message: string) {
  return createNotification({
    userId,
    type: 'SYSTEM',
    title,
    subtitle: fraudCase.displayId ?? undefined,
    message: message.length > 140 ? `${message.slice(0, 139)}…` : message,
    relatedId: fraudCase.id,
  }).catch(() => undefined);
}
