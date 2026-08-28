import { z } from 'zod';

export const createBankAccountSchema = z.object({
  accountHolder: z.string().min(1),
  bankName: z.string().min(1),
  accountNumber: z.string().min(8),
  ifscCode: z.string().min(11).max(11).toUpperCase(),
});

// Deliberately not a .partial() of the create schema: the create schema
// upper-cases ifscCode during parsing, the update path upper-cases it after
// validation instead. Keeping them separate preserves both behaviours exactly.
export const updateBankAccountSchema = z.object({
  accountHolder: z.string().min(1).optional(),
  bankName: z.string().min(1).optional(),
  accountNumber: z.string().min(8).optional(),
  ifscCode: z.string().min(11).max(11).optional(),
});

export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
