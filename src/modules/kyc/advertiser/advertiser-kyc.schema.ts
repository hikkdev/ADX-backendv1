import { z } from 'zod';
import { kycQueueStateSchema } from '../../../shared/kyc-state';

const documentFields = {
  nationalIdUrl: z.string().url().optional(),
  panCardUrl: z.string().url().optional(),
  utilityBillUrl: z.string().url().optional(),
  drivingLicenseUrl: z.string().url().optional(),
  commercialIncCertUrl: z.string().url().optional(),
  commercialAssociationArticleUrl: z.string().url().optional(),
  commercialPanIdUrl: z.string().url().optional(),
  commercialGstCertUrl: z.string().url().optional(),
  ngoRegCertUrl: z.string().url().optional(),
  ngo80gCertUrl: z.string().url().optional(),
  ngoFcraRegUrl: z.string().url().optional(),
  agencyAuthLetterUrl: z.string().url().optional(),
  agencyGovtIdUrl: z.string().url().optional(),
  // DR 08 self-service capture, Steps 6–10 — the same names the publisher side holds.
  govIdType: z.enum(['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE']).optional(),
  govIdFrontUrl: z.string().url().optional(),
  govIdBackUrl: z.string().url().optional(),
  panNumber: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN').optional(),
  panSignatureUrl: z.string().url().optional(),
  addressProofType: z.enum(['UTILITY_BILL', 'RENT_AGREEMENT', 'BANK_STATEMENT']).optional(),
  addressProofUrl: z.string().url().optional(),
  selfieUrl: z.string().url().optional(),
};

const KYC_TYPES = ['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY'] as const;

// Note: kycType uses z.enum, not upperEnum — this field is case-sensitive,
// unlike status. Inherited from the original controller.
/** Lot F: the onboarding-manifest version the phone rendered — pinned on the row at the first submission. */
const manifestVersion = z.number().int().positive().optional();

export const createAdvertiserKycSchema = z.object({
  kycType: z.enum(KYC_TYPES).default('INDIVIDUAL'),
  manifestVersion,
  ...documentFields,
});

/**
 * `PUT /advertiser-kyc/me`: every column optional. Lot D (Q42) / Lot F: while
 * the case is NEEDS_INFO the body is partial — only the flagged DR 08
 * columns (govIdFrontUrl, govIdBackUrl, panFrontUrl→panCardUrl, panSignatureUrl,
 * addressProofUrl, selfieUrl, govIdType, addressProofType, panNumber) — and
 * the columns not sent keep what they hold.
 */
export const updateAdvertiserKycSchema = z.object({
  kycType: z.enum(KYC_TYPES).optional(),
  manifestVersion,
  ...documentFields,
});

export const advertiserKycStatusFilterSchema = z
  .enum(['PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_INFO'])
  .optional();

/** N2-B / N3-B: `GET /advertiser-kyc?advertiserId=` — one advertiser (their profile id **or** their user id), one row or none; blank is ignored like the other facets. */
export const advertiserIdFilterSchema = z.string().trim().min(1).optional();

/** N3-B: `GET /advertiser-kyc?state=` — one of the six party states (`shared/kyc-state`); `status=` is its alias. */
export const advertiserKycStateFilterSchema = kycQueueStateSchema;

/** N3-B: `GET /advertiser-kyc?q=` — the party's name, company, display id, email or mobile contains; blank is ignored. */
export const advertiserKycSearchSchema = z.string().trim().min(1).max(120).optional();

/** The document columns a per-document decision may name (Lot D, Q42). */
export const ADVERTISER_KYC_DOCUMENT_FIELDS = Object.keys(documentFields).filter((key) => key.endsWith('Url')) as readonly string[];

export type CreateAdvertiserKycInput = z.infer<typeof createAdvertiserKycSchema>;
export type UpdateAdvertiserKycInput = z.infer<typeof updateAdvertiserKycSchema>;
/** The columns as the row takes them — `manifestVersion` is pinned separately, never overwritten. */
export type AdvertiserKycColumns = Omit<UpdateAdvertiserKycInput, 'manifestVersion'>;
export type NewAdvertiserKycColumns = Omit<CreateAdvertiserKycInput, 'manifestVersion'>;
