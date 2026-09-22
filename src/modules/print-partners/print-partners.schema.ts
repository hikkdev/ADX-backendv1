import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';
import { PRINT_JOB_STATUSES, QUOTE_REQUEST_STATUSES } from './print-partners.repository';

/** A rupee amount on the wire is a decimal string, never a float. */
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a number with at most two decimal places');

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * Ops creating a partner at the desk — Lot B (B4b). The mobile is the account
 * (unique on User, sign-in disabled); everything else describes the shop.
 */
export const createPartnerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z.string().trim().min(10).max(16),
  legalName: optionalText(200),
  gstin: z.string().trim().toUpperCase().regex(GSTIN, 'That does not look like a GSTIN').nullable().optional(),
  panNumber: z.string().trim().toUpperCase().regex(PAN, 'That does not look like a PAN').nullable().optional(),
  contactName: optionalText(120),
  email: z.string().trim().email().nullable().optional(),
  address: optionalText(500),
  city: optionalText(80),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  maxWidthFt: amount.nullable().optional(),
  turnaroundDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: optionalText(2000),
});

/**
 * Everything but the mobile — the account's identity — and the active
 * switch, which has its own route. G13-B: the desk may also flip
 * `acceptsQuoteRequests` on the partner's behalf (a partner who never
 * activates still has to be reachable, or not, by an AUTO invite).
 */
export const updatePartnerSchema = createPartnerSchema
  .omit({ mobile: true })
  .extend({ acceptsQuoteRequests: z.boolean().optional() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });

export const listPartnersQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  /** PP-1: `applied=true` — the shops that applied from the app and await the desk. */
  applied: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

export const deactivateSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });

export const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

/* ── Jobs ──────────────────────────────────────────────────────── */

export const openJobSchema = z.object({
  printPartnerId: z.string().trim().min(1),
  quotedCost: amount.nullable().optional(),
  specs: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: optionalText(2000),
  /** Lot H: set by the award, never by the desk's own open. */
  awardedQuoteId: z.string().trim().min(1).nullable().optional(),
});

export const updateJobSchema = z
  .object({
    status: z.enum(PRINT_JOB_STATUSES).optional(),
    actualCost: amount.nullable().optional(),
    notes: optionalText(2000),
  })
  .refine((value) => value.status !== undefined || value.actualCost !== undefined || value.notes !== undefined, {
    message: 'Nothing to change',
  });

/* ── Lot H (Q147): the partner's own floor ──────────────────────── */

/**
 * What the partner may change about themselves from the app: the contact,
 * the address the agent collects from, what they can print, and whether
 * quote requests should reach them. The legal identity (name, GSTIN, PAN)
 * and the mobile stay the desk's.
 */
export const updateMeSchema = z
  .object({
    contactName: optionalText(120),
    email: z.string().trim().email().nullable().optional(),
    address: optionalText(500),
    city: optionalText(80),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    capabilities: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    maxWidthFt: amount.nullable().optional(),
    turnaroundDays: z.number().int().min(0).max(365).nullable().optional(),
    acceptsQuoteRequests: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });

/** One line of the rate card: what, per what, at how much. */
export const rateCardRowSchema = z.object({
  material: z.string().trim().min(1).max(80),
  sizeClass: optionalText(60),
  unit: z.string().trim().min(1).max(30),
  ratePerUnit: amount,
  minQty: z.number().int().min(1).max(100000).nullable().optional(),
  notes: optionalText(300),
});

/**
 * The rate card: an uploaded file (purpose PARTNER_RATE_CARD), structured
 * rows, or both. Rows alone are a rate card; a file alone is one too — a
 * shop that only has a PDF is still preferred over one with nothing.
 */
export const rateCardSchema = z
  .object({
    fileId: z.string().trim().min(1).nullable().optional(),
    rows: z.array(rateCardRowSchema).max(200).default([]),
  })
  .refine((value) => Boolean(value.fileId) || value.rows.length > 0, {
    message: 'A rate card needs a file or at least one row',
  });

export const myJobsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(PRINT_JOB_STATUSES)).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

export const myQuoteRequestsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(QUOTE_REQUEST_STATUSES)).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

export const declineJobSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const handoverSchema = z.object({ qrToken: z.string().trim().min(1).max(4000) });

/** The partner's own withdrawal — the method defaults to their VERIFIED default one. */
export const partnerWithdrawalSchema = z.object({
  amount,
  payoutMethodId: z.string().trim().min(1).optional(),
});

/** The month's invoice to ADX: a private file (purpose PARTNER_INVOICE) and the month it covers. */
export const partnerInvoiceSchema = z.object({
  fileId: z.string().trim().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM'),
});

/* ── Lot H: quote requests ─────────────────────────────────────── */

/** Every quote request's deadline when ops names none: two days. */
export const DEFAULT_QUOTE_WINDOW_HOURS = 48;

export const quoteRequestSchema = z.object({
  specs: z.record(z.string(), z.unknown()),
  deadlineAt: z.string().datetime({ offset: true }).optional(),
  invite: z.union([z.literal('AUTO'), z.array(z.string().trim().min(1)).min(1).max(50)]).default('AUTO'),
});

export const quoteSchema = z.object({
  amount,
  turnaroundDays: z.number().int().min(0).max(365),
  note: optionalText(500),
});

export const awardSchema = z.object({
  quoteId: z.string().trim().min(1).optional(),
  note: z.string().trim().min(3).max(500).optional(),
});

/** G13-B: `POST /orders/:id/print-quote-request/cancel` — ops close an OPEN request, saying why. */
export const cancelQuoteRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/** G13-B: `GET /print-quote-requests` — the desk's list across orders, on the list contract. */
export const listQuoteRequestsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(QUOTE_REQUEST_STATUSES)).optional()),
  /** Contains, case-insensitive, on the order id or the city. */
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

/**
 * PP-1: `POST /print-partners/me/application` — the details the desk's create
 * form asks, supplied by the shop itself while its application is open. The
 * legal identity (legal name, GSTIN, PAN) is writable here and only here:
 * once the desk activates, those move the way they always did — at the desk.
 */
export const applicationDetailsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: optionalText(200),
  gstin: z.string().trim().toUpperCase().regex(GSTIN, 'That does not look like a GSTIN').nullable().optional(),
  panNumber: z.string().trim().toUpperCase().regex(PAN, 'That does not look like a PAN').nullable().optional(),
  contactName: optionalText(120),
  email: z.string().trim().email().nullable().optional(),
  address: optionalText(500),
  city: optionalText(80),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  maxWidthFt: amount.nullable().optional(),
  turnaroundDays: z.number().int().min(0).max(365).nullable().optional(),
  acceptsQuoteRequests: z.boolean().optional(),
  notes: optionalText(2000),
});
export type ApplicationDetailsInput = z.infer<typeof applicationDetailsSchema>;
export type RateCardInput = z.infer<typeof rateCardSchema>;
export type RateCardRow = z.infer<typeof rateCardRowSchema>;
export type MyJobsQuery = z.infer<typeof myJobsQuerySchema>;
export type MyQuoteRequestsQuery = z.infer<typeof myQuoteRequestsQuerySchema>;
export type PartnerWithdrawalInput = z.infer<typeof partnerWithdrawalSchema>;
export type PartnerInvoiceInput = z.infer<typeof partnerInvoiceSchema>;
export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;
export type QuoteInput = z.infer<typeof quoteSchema>;
export type AwardInput = z.infer<typeof awardSchema>;
export type CancelQuoteRequestInput = z.infer<typeof cancelQuoteRequestSchema>;
export type ListQuoteRequestsQuery = z.infer<typeof listQuoteRequestsQuerySchema>;

export type CreatePartnerInput = z.infer<typeof createPartnerSchema>;
export type UpdatePartnerInput = z.infer<typeof updatePartnerSchema>;
export type ListPartnersQuery = z.infer<typeof listPartnersQuerySchema>;
export type OpenJobInput = z.infer<typeof openJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
