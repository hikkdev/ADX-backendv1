import { z } from 'zod';
import { agreementKindSchema } from '../agreements.schema';

/** DS-1: the Signatures desk's filters, the desk's own "send for signature", and the void's reason. */

export const signingPartySchema = z.enum(['PUBLISHER', 'ADVERTISER', 'AGENT', 'EMPLOYEE', 'PRINT_PARTNER']);
export const signingStatusSchema = z.enum(['REQUESTED', 'PARTIALLY_SIGNED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED']);

export const signingFilterSchema = z.object({
  kind: agreementKindSchema.optional(),
  status: signingStatusSchema.optional(),
  partyType: signingPartySchema.optional(),
  partyId: z.string().trim().min(1).optional(),
  campaignId: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export const openSigningSchema = z.object({
  kind: agreementKindSchema,
  partyType: signingPartySchema,
  partyId: z.string().trim().min(1),
  campaignId: z.string().trim().min(1).optional(),
  /** The desk may open a request the policy would not ask for — a partner who wants it on paper. */
  force: z.boolean().optional(),
});

export const voidSigningSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type SigningFilterInput = z.infer<typeof signingFilterSchema>;
export type OpenSigningInputBody = z.infer<typeof openSigningSchema>;
