import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { PAYOUT_BATCH_STATUSES } from './payouts.repository';

/** Lot B (Q85/Q140): payout batches and ADX's own bank accounts. */

const rail = z.enum(['MANUAL_NEFT', 'RAZORPAY_X', 'CASHFREE']);

export const batchListQuerySchema = listQuerySchema(PAYOUT_BATCH_STATUSES, ['newest'] as const);

/** G13-B: `GET /finance/payout-batches/export.csv` — the list's filters without its page. */
export const batchExportQuerySchema = batchListQuerySchema.omit({ page: true, pageSize: true, sort: true });
export type BatchExportQuery = z.infer<typeof batchExportQuerySchema>;

export const createBatchSchema = z.object({
  rail: rail.optional(),
  bankAccountId: z.string().trim().min(1).optional(),
  note: z.string().trim().max(400).optional(),
  scheduledFor: z.coerce.date().optional(),
  cutoffAt: z.coerce.date().optional(),
});

export const setLinesSchema = z.object({
  withdrawalIds: z.array(z.string().trim().min(1)).max(500),
});

export const lineMarkPaidSchema = z.object({ utr: z.string().trim().min(1).max(64) });
export const lineFailSchema = z.object({ reason: z.string().trim().min(1).max(400) });

/**
 * PUT /finance/bank-accounts: with `id` an update, without one a create. The
 * whole account number comes in and only its last four digits are stored.
 */
export const bankAccountSchema = z.object({
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).max(80),
  bankName: z.string().trim().min(1).max(120),
  accountHolder: z.string().trim().min(1).max(120).optional(),
  accountNumber: z.string().trim().min(6).max(34).optional(),
  ifsc: z.string().trim().length(11),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export type CreateBatchInput = z.infer<typeof createBatchSchema>;
export type BankAccountInput = z.infer<typeof bankAccountSchema>;
