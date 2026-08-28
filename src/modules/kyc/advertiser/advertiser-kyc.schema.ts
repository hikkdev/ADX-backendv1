import { z } from 'zod';

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
};

const KYC_TYPES = ['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY'] as const;

// Note: kycType uses z.enum, not upperEnum — this field is case-sensitive,
// unlike status. Inherited from the original controller.
export const createAdvertiserKycSchema = z.object({
  kycType: z.enum(KYC_TYPES).default('INDIVIDUAL'),
  ...documentFields,
});

export const updateAdvertiserKycSchema = z.object({
  kycType: z.enum(KYC_TYPES).optional(),
  ...documentFields,
});

export const advertiserKycStatusFilterSchema = z
  .enum(['PENDING', 'VERIFIED', 'REJECTED'])
  .optional();

export type CreateAdvertiserKycInput = z.infer<typeof createAdvertiserKycSchema>;
export type UpdateAdvertiserKycInput = z.infer<typeof updateAdvertiserKycSchema>;
