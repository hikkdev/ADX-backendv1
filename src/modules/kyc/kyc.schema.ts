import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

/**
 * Admin review decision. Identical for advertiser and user KYC, which is the
 * main reason the two live in one module.
 */
export const reviewSchema = z.object({
  status: upperEnum(KYC_STATUSES),
  rejectionReason: z.string().optional(),
  /** Lot D (Q42): what the reviewer said, kept on the record beside who they were. */
  reviewNote: z.string().trim().max(500).optional(),
});

export type ReviewInput = z.infer<typeof reviewSchema>;

/** Page/pageSize parsing shared by both admin listings. */
export function pagination(query: Record<string, unknown>) {
  return {
    page: Math.max(1, Number(query['page'] ?? 1)),
    pageSize: Math.min(100, Math.max(1, Number(query['pageSize'] ?? 20))),
  };
}

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

/* ── Lot D (Q42/Q119): the desk's per-document and assignment bodies ──────── */

export const KYC_QUEUE_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_INFO'] as const;

/** PATCH …/documents/:field — one tile approved or flagged, with what the reviewer said. */
export const documentDecisionSchema = z
  .object({
    decision: upperEnum(['APPROVED', 'FLAGGED'] as const),
    note: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.decision !== 'FLAGGED' || (d.note && d.note.length > 0), {
    message: 'Say what is wrong with the document when flagging it',
    path: ['note'],
  });
export type DocumentDecisionInput = z.infer<typeof documentDecisionSchema>;

/** POST …/request-reupload — the flagged fields the party is asked for again. */
export const reuploadRequestSchema = z.object({
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(30),
  note: z.string().trim().min(1).max(500),
});
export type ReuploadRequestInput = z.infer<typeof reuploadRequestSchema>;

/** PATCH …/assign — an admin's id, `me`, or null to clear. A filter, not ownership. */
export const assignCaseSchema = z.object({
  adminUserId: z.union([z.literal('me'), z.string().trim().min(1).max(64), z.null()]),
});
export type AssignCaseInput = z.infer<typeof assignCaseSchema>;

export const bulkAssignSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  adminUserId: z.union([z.literal('me'), z.string().trim().min(1).max(64), z.null()]),
});
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;

/** `?assignedTo=me|none` on the queues. */
export const assignedToSchema = z.enum(['me', 'none']).optional();

/* ── Lot G (Q127/142): escalation ─────────────────────────────────────────── */

/** POST …/escalate — a reviewer hands the case to Compliance, and says why. */
export const kycEscalateSchema = z.object({
  reason: z.string().trim().min(3, 'Say why it is being escalated').max(1000),
});
export type KycEscalateInput = z.infer<typeof kycEscalateSchema>;

/** `?escalated=true|false` on the queues. */
export const escalatedFilterSchema = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/* ── Lot N: KYC requested from the desk ───────────────────────────────────── */

export const KYC_REQUEST_CHANNELS = ['DIGIO', 'MANUAL'] as const;
export type KycRequestChannel = (typeof KYC_REQUEST_CHANNELS)[number];

/**
 * POST …/request — the desk asks the party for their KYC: on Digio (the
 * session is opened on their behalf and the link reaches them as the
 * integration sends it) or by hand (a notice to come to the desk or upload).
 * The note travels in the notice. N3-B: the channel defaults to DIGIO on
 * every request route, so the console's one click needs no body.
 */
export const kycRequestSchema = z.object({
  channel: upperEnum(KYC_REQUEST_CHANNELS).default('DIGIO'),
  note: z.string().trim().min(1).max(500).optional(),
});
export type KycRequestInput = z.infer<typeof kycRequestSchema>;

/** `?requested=true|false` on the queues — a request with nothing submitted yet. */
export const requestedFilterSchema = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** The deep link a KYC_REQUESTED push opens: the party's own KYC screen in the user app. */
export const KYC_DEEP_LINK = 'adx://kyc';

/** How the request channel reads in the notice. */
export const kycChannelLabel = (channel: KycRequestChannel): string => (channel === 'DIGIO' ? 'Digio' : 'at the ADX desk');
