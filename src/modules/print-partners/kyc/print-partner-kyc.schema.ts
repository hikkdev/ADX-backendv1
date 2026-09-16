import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../../shared/pagination';
import { upperEnum } from '../../../shared/validation';
import { kycQueueStateSchema } from '../../../shared/kyc-state';

/**
 * The print partner's KYC — Lot N (owner, 14 Sep 2026): the wire shapes.
 *
 * The record mirrors the publisher's business branch: the PAN and its
 * signature, the GST certificate, the registration certificate, the
 * business address proof, a director's id, the government id (type, front,
 * back), the bank proof and a selfie. A document is a private file uploaded
 * under `PRINT_PARTNER_KYC` and named by its `/api/v1/files/:id` URL — the
 * same way the publisher's and the advertiser's columns hold theirs.
 */

export const GOV_ID_TYPES = ['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE'] as const;

const documentUrl = z.string().url();

const documentFields = {
  panFrontUrl: documentUrl.optional(),
  panSignatureUrl: documentUrl.optional(),
  gstUrl: documentUrl.optional(),
  businessRegCertUrl: documentUrl.optional(),
  businessAddressProofUrl: documentUrl.optional(),
  directorIdUrl: documentUrl.optional(),
  govIdFrontUrl: documentUrl.optional(),
  govIdBackUrl: documentUrl.optional(),
  bankProofUrl: documentUrl.optional(),
  selfieUrl: documentUrl.optional(),
};

const facts = {
  panNumber: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN').optional(),
  govIdType: upperEnum(GOV_ID_TYPES).optional(),
};

/**
 * `POST /print-partners/me/kyc` and the desk's `PUT /print-partner-kyc/:id`:
 * every column optional — a first submission sends what it has, a
 * NEEDS_INFO resubmission sends only the flagged tiles (and must send at
 * least one document: `EMPTY_RESUBMISSION`).
 */
export const submitPrintPartnerKycSchema = z
  .object({ ...documentFields, ...facts })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to record' });

export type SubmitPrintPartnerKycInput = z.infer<typeof submitPrintPartnerKycSchema>;

/** The document columns a per-document decision, a re-upload request and the purge may name. */
export const PRINT_PARTNER_KYC_DOCUMENT_FIELDS: readonly string[] = Object.keys(documentFields);

export const PRINT_PARTNER_KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_INFO'] as const;

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** `GET /print-partner-kyc` — the advertiser queue's facets plus `requested` and `q`. */
export const printPartnerKycQueueQuerySchema = z.object({
  /** The legacy facet — N3-B: an alias of `state`. */
  status: upperEnum(PRINT_PARTNER_KYC_STATUSES).optional(),
  /** N3-B: one of the six party states — AWAITING_DOCUMENTS, REQUESTED, PENDING, NEEDS_INFO, REJECTED, VERIFIED. */
  state: kycQueueStateSchema,
  /** Lot N: the desk asked and the partner has not yet answered — `requestedAt` set, `submittedAt` null. */
  requested: flag,
  assignedTo: z.enum(['me', 'none']).optional(),
  escalated: flag,
  q: z.string().trim().min(1).max(120).optional(),
  /** Absent means breaches of the review SLA first; `newest` is the arrival order. */
  sort: z.enum(['oldest', 'newest']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type PrintPartnerKycQueueQuery = z.infer<typeof printPartnerKycQueueQuerySchema>;

/** `PATCH /print-partner-kyc/:id/review` — the decision; a rejection must say why. */
export const reviewPrintPartnerKycSchema = z
  .object({
    status: upperEnum(['VERIFIED', 'REJECTED'] as const),
    rejectionReason: z.string().trim().max(1000).optional(),
    reviewNote: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.status !== 'REJECTED' || (d.rejectionReason && d.rejectionReason.length > 0), {
    message: 'rejectionReason is required when status is REJECTED',
    path: ['rejectionReason'],
  });
export type ReviewPrintPartnerKycInput = z.infer<typeof reviewPrintPartnerKycSchema>;

/** `POST /print-partner-kyc/:id/request` — the desk asks the partner for their KYC, over Digio or by hand; N3-B: DIGIO by default, so the one click needs no body. */
export const requestPrintPartnerKycSchema = z.object({
  channel: upperEnum(['DIGIO', 'MANUAL'] as const).default('DIGIO'),
  note: z.string().trim().min(1).max(500).optional(),
});
export type RequestPrintPartnerKycInput = z.infer<typeof requestPrintPartnerKycSchema>;
