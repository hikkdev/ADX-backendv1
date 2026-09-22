import { z } from 'zod';
import { ONBOARDING_SOURCES } from '../../shared/onboarding';
import { listQuerySchema } from '../../shared/pagination';
import { dateOfBirthSchema, genderSchema, upperEnum } from '../../shared/validation';

export const advertiserTypeSchema = z.enum(['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY']);

/**
 * Lot G (Q119): the industry picklist — a constant list in code, served by
 * `GET /advertisers/industries` and the only values the profile accepts.
 * `Other` is the escape hatch; a new industry is a line here, not a free
 * string, so the analytics can group on it.
 */
export const ADVERTISER_INDUSTRIES = [
  'Retail',
  'Food & beverage',
  'Real estate',
  'Education',
  'Healthcare',
  'Automotive',
  'Finance',
  'Entertainment',
  'E-commerce',
  'Government',
  'NGO',
  'Other',
] as const;
export type AdvertiserIndustry = (typeof ADVERTISER_INDUSTRIES)[number];
export const advertiserIndustrySchema = z.enum(ADVERTISER_INDUSTRIES);

export const brandSectorSchema = z.enum([
  'GENERAL',
  'ALCOHOL',
  'TOBACCO',
  'GAMBLING',
  'PHARMA',
  'POLITICAL',
  'FINANCIAL',
  'REAL_ESTATE',
  'EDUCATION',
  'HEALTHCARE',
  'INFANT_NUTRITION',
]);

/**
 * Money arrives as a string with at most two decimals, never as a number.
 *
 * JSON numbers are IEEE doubles, so `10000.10` does not survive the round trip
 * intact. The column is `Decimal(14,2)`; the wire format has to be able to
 * express what the column can hold.
 */
export const moneySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use a decimal amount such as "12500.00"');

const mobileSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number');

/**
 * QR-15: the person behind the account, as the desk types them — the same
 * four the publisher desk takes, and the columns `PATCH /users/me` writes
 * from the app. Given a first name, the account is opened up front with the
 * ADVERTISER role, so the owner's sign-in has nothing left to ask.
 */
const personFields = {
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
  gender: genderSchema.optional(),
};

const registerFields = z.object({
  name: z.string().min(2).max(120),
  /**
   * Required only when `onBehalf` is set. A self-serve signup ignores this and
   * takes the number from the session.
   */
  mobile: mobileSchema.optional(),
  /**
   * An agent opening an account for someone who has not registered yet. The
   * agent is resolved from the caller's own profile, never sent, so nobody can
   * attribute an account to a different agent.
   */
  onBehalf: z.boolean().optional(),
  email: z.string().email().max(160).optional(),
  type: advertiserTypeSchema.optional(),
  companyName: z.string().min(2).max(160).optional(),
  gstin: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/, 'Enter a valid 15-character GSTIN')
    .optional(),
  billingAddress: z.string().min(5).max(400).optional(),
  city: z.string().min(2).max(80).optional(),
  state: z.string().min(2).max(80).optional(),
  /** Lot G (Q119): one of `ADVERTISER_INDUSTRIES`. */
  industry: advertiserIndustrySchema.optional(),
  ...personFields,
});

/**
 * QR-15: the desk onboards the way the app does. A first name marks an
 * onboarding (rather than a bare account held for a number), and then what
 * the app's own flow collects before the first booking is required here
 * too: the last name, the billing address and the city; a company name for
 * anyone but an individual. Email, date of birth, gender, state and GSTIN
 * stay optional — the app does not ask an advertiser for them.
 */
export function deskOnboarding(
  value: { firstName?: string; lastName?: string; type?: string; companyName?: string; billingAddress?: string; city?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.firstName === undefined) return;
  const need = (key: keyof typeof value, message: string) => {
    if (value[key] === undefined || value[key] === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
  };
  need('lastName', 'Needed: the app asks for it.');
  need('billingAddress', 'Needed: the app asks for it before the first booking.');
  need('city', 'Needed: the app asks for it.');
  if ((value.type ?? 'INDIVIDUAL') !== 'INDIVIDUAL') need('companyName', 'Needed for a company or organisation: the app asks for it.');
}

export const registerAdvertiserSchema = registerFields.superRefine(deskOnboarding);

/** QR-15: the roster's cuts beside `q` — the door, and the person who opened it. */
export const advertiserRosterQuerySchema = z.object({
  onboardedVia: upperEnum(ONBOARDING_SOURCES).optional(),
  onboardedById: z.string().trim().min(1).max(60).optional(),
});

export const updateProfileSchema = registerFields
  .omit({ mobile: true, onBehalf: true, industry: true })
  .extend({ industry: advertiserIndustrySchema.nullable().optional() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const createBrandSchema = z.object({
  name: z.string().min(1).max(120),
  sector: brandSectorSchema.optional(),
  logoUrl: z.string().url().max(500).optional(),
  website: z.string().url().max(500).optional(),
});

export const updateBrandSchema = createBrandSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

/**
 * Lot B (Q41/Q118): a structured top-up. The route requires a method — the
 * gateway does not call it, it calls `recordGatewayTopUp` — and a bank
 * transfer must carry its UTR, which is what the CHECK on WalletTopUp says
 * too. `utr` doubles as the cheque number on a CHEQUE.
 */
export const topUpMethodSchema = z.enum(['BANK_TRANSFER', 'CHEQUE', 'GATEWAY']);

export const topUpSchema = z
  .object({
    amount: moneySchema,
    method: topUpMethodSchema,
    utr: z.string().trim().min(4).max(64).optional(),
    receivedAt: z.coerce.date(),
    bankAccountId: z.string().trim().min(1).max(120).optional(),
    proofFileId: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(400).optional(),
  })
  .refine((v) => v.method !== 'BANK_TRANSFER' || Boolean(v.utr), {
    message: 'A bank transfer needs its UTR',
    path: ['utr'],
  })
  .refine((v) => v.method !== 'GATEWAY', {
    message: 'Gateway settlements are recorded by the gateway, not through this route',
    path: ['method'],
  });

export const holdSchema = z.object({
  campaignId: z.string().min(1),
  amount: moneySchema,
});

export const goodwillSchema = z.object({
  amount: moneySchema,
  campaignId: z.string().min(1).optional(),
  note: z.string().min(1).max(400).optional(),
});

export const insertionOrderSchema = z.object({
  campaignId: z.string().min(1),
  /*
   * Lot D (Q123): no `renderedDocument` any more. The document is rendered
   * server-side from the live template and the campaign's spots; text the
   * client sent is ignored rather than recorded as what was agreed.
   */
});


export const refundReasonSchema = z.enum([
  'NO_SUITABLE_ALTERNATIVE',
  'PUBLISHER_WITHDREW',
  'ADVERTISER_LEAVING',
  'OTHER',
]);

export const refundDestinationSchema = z.enum(['WALLET_CREDIT', 'BANK_TRANSFER', 'ORIGINAL_METHOD']);

export const requestRefundSchema = z
  .object({
    amount: moneySchema,
    reason: refundReasonSchema,
    /** Required. A refund with no stated reason is not reviewable later. */
    note: z.string().min(5).max(1000),
    ticketId: z.string().min(1).optional(),
    /** Lot B (Q41): where the money goes. Defaults to credit left in the wallet. */
    destination: refundDestinationSchema.optional(),
    /** The advertiser's recorded agreement to a cash refund. Required unless WALLET_CREDIT. */
    consentNote: z.string().trim().min(5).max(1000).optional(),
    /** The VERIFIED payout method a BANK_TRANSFER goes to. */
    payoutMethodId: z.string().min(1).optional(),
  })
  .refine((v) => (v.destination ?? 'WALLET_CREDIT') === 'WALLET_CREDIT' || Boolean(v.consentNote), {
    message: 'A cash refund needs the advertiser’s recorded consent',
    path: ['consentNote'],
  })
  .refine((v) => v.destination !== 'BANK_TRANSFER' || Boolean(v.payoutMethodId), {
    message: 'A bank transfer needs the payout method to send to',
    path: ['payoutMethodId'],
  });

export const decideRefundSchema = z.object({
  approve: z.boolean(),
  decisionNote: z.string().min(1).max(1000).optional(),
});

export const REFUND_STATUS_VALUES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PAID', 'FAILED'] as const;
export const refundStatusSchema = z.enum(REFUND_STATUS_VALUES);

/** The desk's list, on the list contract: `?status=&page=&pageSize=`. */
export const refundDeskQuerySchema = listQuerySchema(REFUND_STATUS_VALUES, ['newest'] as const);

/** E6: `GET /finance/top-ups?q=<utr>&from=&to=&status=RECONCILED|UNRECONCILED`. */
export const topUpDeskQuerySchema = listQuerySchema(['RECONCILED', 'UNRECONCILED'] as const, ['newest'] as const).extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const markRefundPaidSchema = z.object({ railReference: z.string().trim().min(1).max(120) });
export const failRefundSchema = z.object({ reason: z.string().trim().min(1).max(400) });

export const kycDecisionSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
});

/** AG-5: `PATCH /advertisers/:id/band` — the importance band, ADX's own judgement about who it is dealing with. */
export const partyBandSchema = z.object({ sizeBand: z.enum(['INDIVIDUAL', 'SMALL_AGENCY', 'LARGE_AGENCY']) });
