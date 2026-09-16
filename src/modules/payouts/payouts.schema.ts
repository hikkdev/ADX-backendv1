import { z } from 'zod';

/** A rupee amount on the wire is a decimal string, never a float. */
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a number with at most two decimal places');

export const addMethodSchema = z
  .object({
    type: z.enum(['BANK', 'UPI']).default('BANK'),
    accountHolder: z.string().trim().min(1).optional(),
    bankName: z.string().trim().min(1).optional(),
    accountNumber: z.string().trim().min(8).optional(),
    ifscCode: z.string().trim().length(11).optional(),
    upiVpa: z
      .string()
      .trim()
      .regex(/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/, 'That does not look like a UPI ID')
      .optional(),
  })
  .refine((v) => v.type !== 'UPI' || Boolean(v.upiVpa), {
    message: 'A UPI method needs a VPA',
    path: ['upiVpa'],
  })
  .refine(
    (v) =>
      v.type !== 'BANK' ||
      Boolean(v.accountHolder && v.bankName && v.accountNumber && v.ifscCode),
    { message: 'A bank account needs a holder, bank, number and IFSC', path: ['accountNumber'] }
  );

export const verifyMethodSchema = z.object({
  via: z.enum(['PENNY_DROP', 'NAME_LOOKUP', 'MANUAL']).default('MANUAL'),
  reference: z.string().trim().optional(),
  nameMatchPct: amount.optional(),
});

export const rejectSchema = z.object({ reason: z.string().trim().min(1) });

/**
 * D5: ops adding a method on a party's behalf — an agent's bank account,
 * recorded at the desk. The method fields are parsed with `addMethodSchema`
 * beside it; this only names whose it is.
 */
export const onBehalfSchema = z.object({ userId: z.string().trim().min(1) });
export const methodsQuerySchema = z.object({ userId: z.string().trim().min(1).optional() });

export const requestWithdrawalSchema = z.object({
  amount,
  payoutMethodId: z.string().min(1),
});

/**
 * Lot B (B4b): a withdrawal ops raises for a party who cannot — a print
 * partner's sign-in-disabled account (owner decision 122). The wallet names
 * the party; the method defaults to their VERIFIED default one.
 */
export const onBehalfWithdrawalSchema = z.object({
  walletId: z.string().trim().min(1),
  amount,
  payoutMethodId: z.string().trim().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

export const decisionSchema = z.object({
  note: z.string().trim().optional(),
  rail: z.enum(['MANUAL_NEFT', 'RAZORPAY_X', 'CASHFREE']).optional(),
});

export const markPaidSchema = z.object({ railReference: z.string().trim().min(1) });

export const failSchema = z.object({ reason: z.string().trim().min(1) });

const WALLET_ENTRY_TYPES = [
  'TOPUP', 'CAMPAIGN_DEBIT', 'PACKAGE_DEBIT', 'GOODWILL_CREDIT', 'REFUND', 'ADJUSTMENT',
  'EARNING', 'BONUS', 'REFERRAL', 'PAYOUT', 'PENALTY', 'EXPIRY',
] as const;

/** `?type=` is a comma list — the frame's chips (Payments / Payouts / Refunds) are unions of entry types. */
export const entriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  type: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(WALLET_ENTRY_TYPES)).optional()),
});

const INCENTIVE_EVENTS = [
  'PUBLISHER_ONBOARDED',
  'SITE_VISIT',
  'CAMPAIGN_ASSIST',
  'MILESTONE_BONUS',
  'TIER_BONUS',
  'PACKAGE_SOLD',
  // Lot B (Q101/Q102).
  'INSTALLATION',
  'ADVERTISER_ONBOARDED',
] as const;

/** `?event=` is a comma list; the history pages on a cursor so "Load more" is real. */
export const incentivesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  event: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(INCENTIVE_EVENTS)).optional()),
});

/** Lot B (Q140): the queue filters — reference or party name, party kind, and a requested-at window. */
export const withdrawalQuerySchema = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
  q: z.string().trim().min(1).max(120).optional(),
  partyKind: z.enum(['PUBLISHER', 'AGENT', 'ADVERTISER', 'PRINT_PARTNER']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  batchId: z.string().trim().min(1).optional(),
  /** E6: one party's lines, and the paid-out window. */
  walletId: z.string().trim().min(1).optional(),
  publisherId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  paidFrom: z.coerce.date().optional(),
  paidTo: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const walletQuerySchema = z.object({
  kind: z.enum(['PUBLISHER', 'AGENT', 'ADVERTISER', 'PRINT_PARTNER']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const setLimitSchema = z.object({
  band: z.enum(['INDIVIDUAL', 'SMALL_AGENCY', 'LARGE_AGENCY']),
  minMonths: z.coerce.number().int().min(0).max(120),
  dailyCap: amount,
});

export const setTaxRateSchema = z.object({
  appliesTo: z.enum(['PUBLISHER', 'AGENT', 'PARTNER']),
  section: z.string().trim().min(3),
  ratePct: amount,
  effectiveFrom: z.coerce.date().optional(),
  note: z.string().trim().optional(),
});

export const setIncentiveRateSchema = z.object({
  event: z.enum(INCENTIVE_EVENTS),
  tier: z.string().trim().optional(),
  amount,
  effectiveFrom: z.coerce.date().optional(),
});

export const recordIncentiveSchema = z.object({
  agentId: z.string().min(1),
  event: z.enum(INCENTIVE_EVENTS),
  tier: z.string().trim().default('BRONZE'),
  orderId: z.string().optional(),
  publisherId: z.string().optional(),
  advertiserId: z.string().optional(),
  note: z.string().trim().optional(),
});

export const incentiveQuerySchema = z.object({
  agentId: z.string().optional(),
  /** Lot B: the commission recorded against one order. */
  orderId: z.string().optional(),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
  /** E6: `?event=` as a comma list, and `?q=` over the note, the order and the agent's name. */
  event: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((e) => e.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(INCENTIVE_EVENTS)).optional()),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const LEDGER_KINDS = [
  'TOPUP', 'CAMPAIGN_SPEND', 'PACKAGE_SPEND', 'PUBLISHER_EARNING', 'AGENT_INCENTIVE', 'PAYOUT', 'REFUND',
  'GOODWILL', 'PENALTY', 'ADJUSTMENT', 'EXPIRY', 'PRINT_COST', 'REVERSAL',
] as const;

export const ledgerQuerySchema = z.object({
  walletId: z.string().optional(),
  /** E6: `?kind=` as a comma list, `?from=&to=` on occurredAt, `?amount=` matches a leg's absolute value. */
  kind: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((k) => k.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(LEDGER_KINDS)).optional()),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  amount: amount.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

/**
 * Lot B (B1, Q135): the quantity backfill. Dry run unless the caller says
 * otherwise — the list is read before the button is pressed.
 */
export const quantityBackfillSchema = z.object({
  dryRun: z.boolean().default(true),
});

export type AddMethodInput = z.infer<typeof addMethodSchema>;
export type QuantityBackfillInput = z.infer<typeof quantityBackfillSchema>;
