import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';

/* ── The legal entity ───────────────────────────────────────────────── */

/** 15 characters: state code, PAN, entity number, Z, check character. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
export const CIN_PATTERN = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

const upper = (max: number) => z.string().trim().toUpperCase().max(max);
/** An empty string clears the field; null clears it too. */
const clearable = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? null : value), schema.nullable().optional());

export const legalEntityPatchSchema = z
  .strictObject({
    legalName: clearable(z.string().trim().min(2).max(200)),
    tradeName: clearable(z.string().trim().min(1).max(200)),
    gstin: clearable(upper(15).regex(GSTIN_PATTERN, 'A GSTIN is 15 characters: 29ABCDE1234F1Z5')),
    pan: clearable(upper(10).regex(PAN_PATTERN, 'A PAN is 10 characters: ABCDE1234F')),
    tan: clearable(upper(10).regex(TAN_PATTERN, 'A TAN is 10 characters: BLRA12345B')),
    cin: clearable(upper(21).regex(CIN_PATTERN, 'A CIN is 21 characters: U12345KA2020PTC123456')),
    registeredAddress: clearable(z.string().trim().min(4).max(600)),
    city: clearable(z.string().trim().min(1).max(120)),
    stateCode: clearable(z.string().trim().regex(/^\d{2}$/, 'A GST state code is two digits')),
    stateName: clearable(z.string().trim().min(2).max(80)),
    invoicePrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,8}$/, 'A prefix is 1-8 letters or digits')
      .optional(),
    financialYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
  })
  .superRefine((value, ctx) => {
    // The GSTIN carries both the state and the PAN; a row that contradicts
    // itself would print a wrong number on every invoice.
    if (value.gstin && value.stateCode && value.gstin.slice(0, 2) !== value.stateCode) {
      ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'The state code does not match the GSTIN' });
    }
    if (value.gstin && value.pan && value.gstin.slice(2, 12) !== value.pan) {
      ctx.addIssue({ code: 'custom', path: ['pan'], message: 'The PAN does not match the GSTIN' });
    }
  });

export type LegalEntityPatch = z.infer<typeof legalEntityPatchSchema>;

/* ── Invoices ───────────────────────────────────────────────────────── */

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID'] as const;
export const INVOICE_KINDS = ['TAX_INVOICE', 'PROFORMA', 'CREDIT_NOTE'] as const;

const isoDate = z.coerce.date();

export const listInvoicesQuerySchema = listQuerySchema(INVOICE_STATUSES, ['newest', 'oldest'] as const).extend({
  kind: z.enum(INVOICE_KINDS).optional(),
  advertiserId: z.string().trim().min(1).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(400) });

export const issueInvoiceSchema = z
  .object({
    campaignId: z.string().trim().min(1).optional(),
    packageSaleId: z.string().trim().min(1).optional(),
  })
  .refine((value) => Boolean(value.campaignId) !== Boolean(value.packageSaleId), {
    message: 'Name a campaign or a package sale, not both',
  });

/* ── Publisher invoices ─────────────────────────────────────────────── */

export const PUBLISHER_INVOICE_STATUSES = ['UPLOADED', 'MATCHED', 'REJECTED'] as const;

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const uploadPublisherInvoiceSchema = z.object({
  period: z.string().trim().regex(PERIOD_PATTERN, 'A period is YYYY-MM'),
  fileId: z.string().trim().min(1),
  gstin: z.preprocess(
    (value) => (value === '' ? undefined : value),
    upper(15).regex(GSTIN_PATTERN, 'A GSTIN is 15 characters').optional(),
  ),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount is a decimal string with up to two places'),
});
export type UploadPublisherInvoiceInput = z.infer<typeof uploadPublisherInvoiceSchema>;

export const listPublisherInvoicesQuerySchema = listQuerySchema(PUBLISHER_INVOICE_STATUSES, ['newest'] as const).extend({
  publisherId: z.string().trim().min(1).optional(),
  period: z.string().trim().regex(PERIOD_PATTERN).optional(),
});
export type ListPublisherInvoicesQuery = z.infer<typeof listPublisherInvoicesQuerySchema>;

export const reviewPublisherInvoiceSchema = z.object({
  status: z.enum(['MATCHED', 'REJECTED']),
  note: z.string().trim().max(400).optional(),
});
export type ReviewPublisherInvoiceInput = z.infer<typeof reviewPublisherInvoiceSchema>;
