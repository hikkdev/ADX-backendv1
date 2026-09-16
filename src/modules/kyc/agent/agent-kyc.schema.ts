import { z } from 'zod';
import { kycQueueStateSchema } from '../../../shared/kyc-state';

/**
 * D4 — an agent's identity documents, recorded at ADX's desk.
 *
 * The same seven fields DR 08 gives a publisher or an advertiser (government
 * ID, PAN with its typed number and signature, an address proof, a live
 * selfie) plus the bank proof an agent needs before anything is paid out.
 * Every field is optional on the wire so ops can record what they have and
 * come back for the rest; the review decides whether it is enough.
 */
export const agentKycDocumentsSchema = z.object({
  govIdType: z.enum(['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE']).optional(),
  govIdFrontUrl: z.string().url().optional(),
  govIdBackUrl: z.string().url().optional(),
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
    .optional(),
  panFrontUrl: z.string().url().optional(),
  panSignatureUrl: z.string().url().optional(),
  addressProofType: z.enum(['UTILITY_BILL', 'RENT_AGREEMENT', 'BANK_STATEMENT']).optional(),
  addressProofUrl: z.string().url().optional(),
  selfieUrl: z.string().url().optional(),
  bankProofUrl: z.string().url().optional(),
});

export type AgentKycDocuments = z.infer<typeof agentKycDocumentsSchema>;

export const agentKycStatusFilterSchema = z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional();

/** N3-B: `GET /agent-kyc?state=` — one of the six party states; `status=` is its alias. */
export const agentKycStateFilterSchema = kycQueueStateSchema;

/** N3-B: `GET /agent-kyc?q=` — the agent's name, display id or mobile contains; blank is ignored. */
export const agentKycSearchSchema = z.string().trim().min(1).max(120).optional();
