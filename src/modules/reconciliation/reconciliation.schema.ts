import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { LINE_STATUSES } from './reconciliation.repository';

/** Lot B (Q85): what the reconciliation desk sends. */

const column = z.string().trim().min(1).max(60);

export const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(60),
  bankName: z.string().trim().min(1).max(120),
  columns: z
    .object({
      date: column,
      description: column,
      utr: column.optional(),
      debit: column.optional(),
      credit: column.optional(),
      amount: column.optional(),
      balance: column.optional(),
    })
    .refine((v) => Boolean(v.debit || v.credit || v.amount), {
      message: 'Name a debit, a credit or an amount column',
      path: ['amount'],
    }),
  /** `dd/MM/yyyy`, `yyyy-MM-dd`, `dd-MMM-yy` — tokens dd, MM, MMM, yy, yyyy. */
  dateFormat: z.string().trim().regex(/^(dd|MM|MMM|yy|yyyy)([^A-Za-z0-9]+(dd|MM|MMM|yy|yyyy))*$/).optional(),
});

export const importBodySchema = z.object({
  bankAccountId: z.string().trim().min(1),
  profileId: z.string().trim().min(1).optional(),
});

export const importsQuerySchema = z.object({
  bankAccountId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const linesQuerySchema = listQuerySchema(LINE_STATUSES, ['newest'] as const).extend({
  bankAccountId: z.string().trim().min(1).optional(),
  importId: z.string().trim().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Lot G (Q125): the lines export takes the list's filters and never a page — it walks the whole result under the cap. */
export const linesExportQuerySchema = listQuerySchema(LINE_STATUSES, ['newest'] as const)
  .omit({ page: true, pageSize: true, sort: true })
  .extend({
    bankAccountId: z.string().trim().min(1).optional(),
    importId: z.string().trim().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: 'from must not be after to', path: ['from'] });

export const importIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });

export const windowSchema = z.object({
  bankAccountId: z.string().trim().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const matchSchema = z
  .object({
    withdrawalId: z.string().trim().min(1).optional(),
    topUpId: z.string().trim().min(1).optional(),
    paymentId: z.string().trim().min(1).optional(),
    ledgerTransactionId: z.string().trim().min(1).optional(),
    note: z.string().trim().max(400).optional(),
  })
  .refine((v) => [v.withdrawalId, v.topUpId, v.paymentId, v.ledgerTransactionId].filter(Boolean).length === 1, {
    message: 'Name exactly one of withdrawalId, topUpId, paymentId or ledgerTransactionId',
    path: ['withdrawalId'],
  });

export const ignoreSchema = z.object({ note: z.string().trim().max(400).optional() });

export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type LinesQuery = z.infer<typeof linesQuerySchema>;
export type LinesExportQuery = z.infer<typeof linesExportQuerySchema>;
export type MatchInput = z.infer<typeof matchSchema>;
