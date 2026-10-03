import { z } from 'zod';
import { VEHICLE_NUMBER_PATTERN, VERIFICATION_CASE_TYPES, normaliseVehicleNumber } from '../../../shared/verification';

/**
 * Cashfree Phase 1 — the bodies of the verification session's steps and of
 * the desk's reads. Strict where a stray key could be a typo for a field
 * that matters; a value is trimmed and upper-cased before its pattern is
 * read, so "abcpv1234d " is the PAN it plainly is.
 */

/** DigiLocker sends the person back here. Cashfree takes only an https address; the apps pass their universal link, the website its page. */
export const digilockerStartSchema = z.strictObject({
  redirectUrl: z
    .string()
    .trim()
    .max(500)
    .url()
    .refine((value) => value.startsWith('https://'), { message: 'The address must start with https://' }),
});

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : value);

export const bankStepSchema = z.strictObject({
  accountNumber: z.preprocess(upper, z.string().regex(/^[A-Z0-9]{6,40}$/, 'An account number is 6 to 40 letters and digits')),
  ifsc: z.preprocess(upper, z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC is 4 letters, a zero and 6 characters')),
});

export const businessStepSchema = z.strictObject({
  pan: z.preprocess(upper, z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN is 5 letters, 4 digits and a letter')),
  gstin: z.preprocess((value) => (value === '' || value === null ? undefined : upper(value)), z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'A GSTIN is 15 characters, the first two digits').optional()),
});

export const drivingLicenceStepSchema = z.strictObject({
  dlNumber: z.preprocess(upper, z.string().regex(/^[A-Z0-9-]{5,30}$/, 'A licence number is 5 to 30 letters and digits')),
  dob: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'The date of birth is YYYY-MM-DD'),
});

export const vehicleStepSchema = z.strictObject({
  vehicleNumber: z.preprocess((value) => (typeof value === 'string' ? normaliseVehicleNumber(value) : value), z.string().regex(VEHICLE_NUMBER_PATTERN, 'A registration number looks like KA01AB1234')),
});

/** `GET /verification/attempts?caseType=&caseId=` and the case in the resend route's path. */
export const caseSchema = z.object({
  caseType: z.preprocess((value) => (typeof value === 'string' ? value.trim().toUpperCase() : value), z.enum(VERIFICATION_CASE_TYPES)),
  caseId: z.string().trim().min(1).max(64),
});

/** The selfie: Cashfree's face match takes a JPEG or a PNG of at most 5 MB. */
export const SELFIE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const SELFIE_MAX_BYTES = 5 * 1024 * 1024;
