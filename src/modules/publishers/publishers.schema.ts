import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const PUBLISHER_TYPES = ['INDIVIDUAL', 'BUSINESS', 'NGO', 'POLITICAL'] as const;

export const createPublisherSchema = z.object({
  name: z.string().min(1),
  mobile: z.string().min(10),
  email: z.string().email().optional(),
  type: upperEnum(PUBLISHER_TYPES).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

// Mobile is absent on purpose: it identifies the publisher and is not editable
// through this endpoint.
export const updatePublisherSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  type: upperEnum(PUBLISHER_TYPES).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export const registerPublisherSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

export const submitKycSchema = z.object({
  aadhaarFrontUrl: z.string().url().optional(),
  aadhaarBackUrl: z.string().url().optional(),
  panFrontUrl: z.string().url().optional(),
  panBackUrl: z.string().url().optional(),
  gstUrl: z.string().url().optional(),
  addressProofUrl: z.string().url().optional(),
  bankStatement: z.string().url().optional(),
  // Business / NGO documents ported from legacy AdSpaceKyc — optional, only
  // relevant for COMMERCIAL / NGO publisher types
  businessRegCertUrl: z.string().url().optional(),
  directorIdUrl: z.string().url().optional(),
  businessAddressProofUrl: z.string().url().optional(),
  adAuthLetterUrl: z.string().url().optional(),
  ngoRegCertUrl: z.string().url().optional(),
  ngoAddressProofUrl: z.string().url().optional(),
  ngoTaxExemptionCertUrl: z.string().url().optional(),
  ngoOperationalOverviewUrl: z.string().url().optional(),
});

// A rejection without a reason is useless to the publisher, so the schema
// requires one rather than leaving it to the caller.
export const reviewKycSchema = z
  .object({
    status: upperEnum(['VERIFIED', 'REJECTED'] as const),
    rejectionReason: z.string().optional(),
  })
  .refine(
    (d) => d.status !== 'REJECTED' || (d.rejectionReason && d.rejectionReason.trim().length > 0),
    { message: 'rejectionReason is required when status is REJECTED', path: ['rejectionReason'] },
  );
