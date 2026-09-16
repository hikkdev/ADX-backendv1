import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { upperEnum } from '../../shared/validation';

/**
 * Fraud cases — Lot D (Q54/Q92/Q121).
 *
 * Vocabulary and validation. The subject is one of the four parties the
 * suspension module knows (`SuspendedPartyType`), because a confirmed case
 * ends in a suspension and there is no fifth thing to suspend. `kind` is a
 * controlled string rather than an enum — the same choice `Listing` makes for
 * illumination — so ops can name a new pattern of abuse without a migration.
 */

/** Lot G (Q118): ESCALATED is a working status — still open, handed up; `decide` still closes it. */
export const FRAUD_CASE_STATUSES = ['OPEN', 'INVESTIGATING', 'ESCALATED', 'CONFIRMED', 'DISMISSED'] as const;
export type FraudCaseStatusValue = (typeof FRAUD_CASE_STATUSES)[number];

export const FRAUD_SUBJECT_TYPES = ['LISTING', 'PUBLISHER', 'ADVERTISER', 'AGENT'] as const;
export type FraudSubjectType = (typeof FRAUD_SUBJECT_TYPES)[number];

export const SUSPENSION_SCOPES = ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL', 'FREEZE_WALLET', 'BLOCK_SIGNIN'] as const;

export type SuspensionScopeValue = (typeof SUSPENSION_SCOPES)[number];

/** Decision 121: the wallet freeze is the FREEZE_WALLET scope; a confirmed case blocks new work and freezes the money by default. */
export const DEFAULT_CONFIRMED_SCOPES: readonly SuspensionScopeValue[] = ['BLOCK_NEW', 'FREEZE_WALLET'];

/** What a piece of evidence can be. Free text, bounded, so the desk can say "call recording" without a release. */
const evidenceKind = z.string().trim().min(1).max(40);

/** The statuses under which a case is still being worked — what "an open case" means to the scan and to disputes. */
export const OPEN_CASE_STATUSES = ['OPEN', 'INVESTIGATING', 'ESCALATED'] as const;

/** The kind the nightly signal scan opens under. */
export const SIGNAL_SCAN_KIND = 'SIGNAL_SCAN';

export const listCasesQuerySchema = listQuerySchema(FRAUD_CASE_STATUSES, ['NEWEST', 'OLDEST']).extend({
  subjectType: upperEnum(FRAUD_SUBJECT_TYPES).optional(),
  subjectId: z.string().trim().min(1).max(64).optional(),
  disputeId: z.string().trim().min(1).max(64).optional(),
});
export type ListCasesQuery = z.infer<typeof listCasesQuerySchema>;

export const openCaseSchema = z.object({
  subjectType: upperEnum(FRAUD_SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(64),
  kind: z.string().trim().min(2).max(60),
  summary: z.string().trim().min(10, 'Say what was seen — it is the case record').max(4000),
  disputeId: z.string().trim().min(1).max(64).optional(),
  assignedToUserId: z.string().trim().min(1).max(64).optional(),
});
export type OpenCaseInput = z.infer<typeof openCaseSchema>;

export const addNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });

export const addEvidenceSchema = z
  .object({
    kind: evidenceKind,
    fileId: z.string().trim().min(1).max(64).optional(),
    url: z.string().url().max(2048).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((body) => body.fileId !== undefined || body.url !== undefined || body.note !== undefined, {
    message: 'Evidence points at a file, a link or a note',
  });
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;

/** Working the case: the only status this patch may set is INVESTIGATING; a decision goes through /decide. */
export const patchCaseSchema = z
  .object({
    status: z.literal('INVESTIGATING').optional(),
    assignedToUserId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type PatchCaseInput = z.infer<typeof patchCaseSchema>;

export const decideCaseSchema = z.object({
  status: upperEnum(['CONFIRMED', 'DISMISSED'] as const),
  decision: z.string().trim().min(3, 'Say why — it goes on the record').max(4000),
  /** CONFIRMED only. Omitted, the default pair applies; validated against the subject's own list by the suspension module. */
  scopes: z.array(z.enum(SUSPENSION_SCOPES)).min(1).max(SUSPENSION_SCOPES.length).optional(),
});
export type DecideCaseInput = z.infer<typeof decideCaseSchema>;

/** Lot G (Q118): POST /cases/:caseId/escalate — handed up with a note, optionally to a named admin. */
export const escalateCaseSchema = z.object({
  note: z.string().trim().min(3, 'Say why it is being escalated').max(4000),
  toUserId: z.string().trim().min(1).max(64).optional(),
});
export type EscalateCaseInput = z.infer<typeof escalateCaseSchema>;

/** Lot G (Q138): POST /scan/:subjectType/:subjectId — the signals over a party with no case. */
export const scanParamsSchema = z.object({
  subjectType: upperEnum(FRAUD_SUBJECT_TYPES),
  subjectId: z.string().trim().min(1).max(64),
});
