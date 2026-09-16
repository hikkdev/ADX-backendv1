import { z } from 'zod';
import { kycQueueStateSchema } from '../../../shared/kyc-state';

/**
 * Lot D (Q131) — an employee's identity documents, recorded at ADX's desk.
 *
 * The same set an agent's record holds (`kyc/agent`): government ID, PAN
 * with its typed number and signature, an address proof, a live selfie,
 * and the bank proof payroll needs. Every field is optional on the wire so
 * HR can record what they have and come back for the rest; the review
 * decides whether it is enough. Files are uploaded with purpose
 * `EMPLOYEE_KYC`, which is private.
 */
export const employeeKycDocumentsSchema = z.object({
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

export type EmployeeKycDocuments = z.infer<typeof employeeKycDocumentsSchema>;

export const employeeKycStatusFilterSchema = z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional();

/** N3-B: `GET /employee-kyc?state=` — one of the six party states (`shared/kyc-state`); `status=` is its alias. */
export const employeeKycStateFilterSchema = kycQueueStateSchema;

/** N3-B: `GET /employee-kyc?q=` — the employee's name, display id, email or mobile contains; blank is ignored. */
export const employeeKycSearchSchema = z.string().trim().min(1).max(120).optional();
