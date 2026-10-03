/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026) — the vocabulary of the
 * verification layer.
 *
 * Imports nothing on purpose: `shared/integrations` reads these names to
 * type the `verificationRouting` section of the credentials row, and the
 * router reads that section to pick a provider, so the names have to sit
 * underneath both (the same arrangement as `shared/sms/kinds.ts`).
 *
 * A **check** is one question asked of a provider — is this PAN real, does
 * this account exist, is this face alive. A **provider** answers some of
 * them. The owner's routing decision: Digio stays the primary for the
 * hosted KYC journey; Cashfree Secure ID is its automatic backup and the
 * only provider of every other check.
 *
 * The one rule the whole layer is built round: a provider that could not
 * answer (a TECHNICAL failure) is failed over; a provider that answered —
 * "this PAN is invalid", "the names do not match", "the account is closed",
 * "consent denied" — gave a BUSINESS answer, and a business answer is
 * FINAL. Nobody is asked for a second opinion.
 */

export const CHECK_TYPES = [
  'PAN',
  'BANK_ACCOUNT',
  'UPI_VPA',
  'GSTIN',
  'VEHICLE_RC',
  'DRIVING_LICENCE',
  'FACE_LIVENESS',
  'FACE_MATCH',
  'NAME_MATCH',
  'DIGILOCKER',
  'HOSTED_KYC',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const isCheckType = (value: unknown): value is CheckType => typeof value === 'string' && (CHECK_TYPES as readonly string[]).includes(value);

export const VERIFICATION_PROVIDER_NAMES = ['DIGIO', 'CASHFREE_SECURE_ID'] as const;
export type VerificationProviderName = (typeof VERIFICATION_PROVIDER_NAMES)[number];

export const isVerificationProviderName = (value: unknown): value is VerificationProviderName =>
  typeof value === 'string' && (VERIFICATION_PROVIDER_NAMES as readonly string[]).includes(value);

/** What a party's KYC row writes in its `method` column for each provider. */
export const KYC_METHOD_OF: Record<VerificationProviderName, 'DIGIO' | 'CASHFREE'> = { DIGIO: 'DIGIO', CASHFREE_SECURE_ID: 'CASHFREE' };

export const CHECK_STATUSES = ['VERIFIED', 'FAILED', 'PENDING', 'NEEDS_USER_ACTION'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/**
 * Why a provider could not answer. Every one of these is TECHNICAL: the
 * router moves to the next provider on it.
 *
 *   TIMEOUT                the call did not come back in time
 *   NETWORK                the call never reached the provider
 *   HTTP_5XX               the provider (or the source behind it) is down
 *   RATE_LIMITED           429
 *   AUTH_CONFIG            401/403, missing keys, a missing or bad signature / public key
 *   NOT_ENABLED            the product is not activated on the account (DigiLocker answers 404)
 *   INSUFFICIENT_BALANCE   the prepaid Secure ID wallet is empty (422)
 *   PROVIDER_SWITCHED_OFF  Digio's switch is MANUAL or DEGRADED
 *   MOCK_IN_PRODUCTION     Digio has no keys on a production server (the mock is development-only)
 *   CIRCUIT_OPEN           the provider's breaker is open; it was not called
 */
export const TECHNICAL_ERROR_CLASSES = [
  'TIMEOUT',
  'NETWORK',
  'HTTP_5XX',
  'RATE_LIMITED',
  'AUTH_CONFIG',
  'NOT_ENABLED',
  'INSUFFICIENT_BALANCE',
  'PROVIDER_SWITCHED_OFF',
  'MOCK_IN_PRODUCTION',
  'CIRCUIT_OPEN',
] as const;
export type TechnicalErrorClass = (typeof TECHNICAL_ERROR_CLASSES)[number];

/** BUSINESS is a definite answer — final, never failed over. */
export type ErrorClass = TechnicalErrorClass | 'BUSINESS';

export const isTechnical = (errorClass: ErrorClass | null | undefined): errorClass is TechnicalErrorClass =>
  Boolean(errorClass) && errorClass !== 'BUSINESS';

/**
 * The technical classes that count towards a provider's breaker: the ones
 * a real call produced and that would fail the next call too. A product
 * that is not enabled (one check, not the provider), a switch someone
 * threw, the production mock guard and the breaker's own refusal made no
 * call that says anything about the provider's health.
 */
export const BREAKER_COUNTED_CLASSES: readonly TechnicalErrorClass[] = ['TIMEOUT', 'NETWORK', 'HTTP_5XX', 'RATE_LIMITED', 'AUTH_CONFIG', 'INSUFFICIENT_BALANCE'];

/** What the person must do next, when a check cannot finish without them. Never stored. */
export type UserAction = { kind: 'REDIRECT'; url: string; expiresAt: string | null };

/**
 * One check's answer.
 *
 * `raw` is what is KEPT on the attempt, so it is PII-minimised by the
 * provider before it gets here: never a full Aadhaar number, never an
 * image, never an XML link; numbers masked to their last four. `transient`
 * is what the caller may read in memory and must not store as it is (the
 * DigiLocker photo for the face match, the full RC row a listing keeps on
 * its own record) — the router drops it before anything is written.
 */
export interface CheckResult {
  status: CheckStatus;
  provider: VerificationProviderName;
  /** The provider's own id for the call (Cashfree's `reference_id`, Digio's request id). */
  providerRef: string | null;
  /** ADX's id for the call — the attempt's id, sent as `verification_id` where the API takes one. */
  verificationId: string;
  matchedName?: string | undefined;
  /** 0–100, whatever scale the provider answered on. */
  nameMatchScore?: number | undefined;
  /** Set on FAILED: BUSINESS (final) or the technical class (failed over). */
  errorClass?: ErrorClass | undefined;
  failureCode?: string | undefined;
  failureReason?: string | undefined;
  raw: Record<string, unknown>;
  userAction?: UserAction | undefined;
  transient?: unknown;
}

export type ImageInput = { bytes: Buffer; mime: 'image/jpeg' | 'image/png'; filename?: string | undefined };

export const DIGILOCKER_DOCUMENTS = ['AADHAAR', 'PAN', 'DRIVING_LICENSE'] as const;
export type DigilockerDocument = (typeof DIGILOCKER_DOCUMENTS)[number];

/** What each check is asked with. */
export interface CheckInputs {
  PAN: { pan: string; name?: string | undefined };
  BANK_ACCOUNT: { accountNumber: string; ifsc: string; name?: string | null | undefined; phone?: string | null | undefined; mode?: 'SYNC' | 'ASYNC' | undefined };
  /**
   * `consent` is the account holder's own, captured by the surface they are
   * on: Cashfree's UPI penny drop refuses a consent older than five minutes.
   */
  UPI_VPA: { vpa: string; name?: string | undefined; consent?: { obtainedAt: Date; purpose: string } | undefined; redirectUrl?: string | undefined };
  GSTIN: { gstin: string; businessName?: string | undefined };
  VEHICLE_RC: { vehicleNumber: string };
  DRIVING_LICENCE: { dlNumber: string; dob: string };
  FACE_LIVENESS: { image: ImageInput };
  FACE_MATCH: { first: ImageInput; second: ImageInput; threshold?: number | undefined };
  NAME_MATCH: { name1: string; name2: string };
  DIGILOCKER: { documents: DigilockerDocument[]; redirectUrl?: string | undefined; userFlow?: 'signin' | 'signup' | undefined };
  /** The hosted journey. `digio` is the request as the Digio client takes it; Cashfree's equivalent is a session of the checks above. */
  HOSTED_KYC: {
    digio: {
      party: 'PUBLISHER' | 'ADVERTISER' | 'AGENT' | 'PRINT_PARTNER' | 'EMPLOYEE';
      workflowKey: string | null;
      referenceId: string;
      customerName: string;
      customerEmail: string;
      customerMobile: string;
    };
  };
}

/** What a verification is about — the party's KYC, a payout method, a listing. */
export const VERIFICATION_CASE_TYPES = ['PUBLISHER_KYC', 'ADVERTISER_KYC', 'AGENT_KYC', 'PRINT_PARTNER_KYC', 'EMPLOYEE_KYC', 'PAYOUT_METHOD', 'LISTING'] as const;
export type VerificationCaseType = (typeof VERIFICATION_CASE_TYPES)[number];

export const isVerificationCaseType = (value: unknown): value is VerificationCaseType =>
  typeof value === 'string' && (VERIFICATION_CASE_TYPES as readonly string[]).includes(value);

/** The five KYC case types, by the party the Digio client names. */
export const KYC_CASE_TYPE_OF = {
  PUBLISHER: 'PUBLISHER_KYC',
  ADVERTISER: 'ADVERTISER_KYC',
  AGENT: 'AGENT_KYC',
  PRINT_PARTNER: 'PRINT_PARTNER_KYC',
  EMPLOYEE: 'EMPLOYEE_KYC',
} as const satisfies Record<string, VerificationCaseType>;

/**
 * The UPI check the owner has chosen.
 *
 *   VPA_LOOKUP          Digio looks the UPI ID up: live or not, and the name
 *                       on it. No money moves, nobody has to be present. The
 *                       DEFAULT (the owner, 2 Oct 2026 — the main UPI check);
 *                       Cashfree's penny drop is its backup, and only when the
 *                       account holder has just consented.
 *   PENNY_DROP          Cashfree sends ₹1 — needs the holder's consent from the last five minutes.
 *   REVERSE_PENNY_DROP  The holder pays ₹1 from the UPI ID.
 *   NONE                No UPI check; no UPI method is ever marked verified by one.
 *
 * In the order the settings card offers them. A value stored before
 * VPA_LOOKUP existed is kept as stored.
 */
export const UPI_CHECK_MODES = ['VPA_LOOKUP', 'PENNY_DROP', 'REVERSE_PENNY_DROP', 'NONE'] as const;
export type UpiCheckMode = (typeof UPI_CHECK_MODES)[number];
export const DEFAULT_UPI_CHECK: UpiCheckMode = 'VPA_LOOKUP';

/** How old the holder's consent may be for Cashfree's UPI penny drop — Cashfree refuses anything older. */
export const UPI_CONSENT_WINDOW_MS = 5 * 60 * 1000;

/** True when a UPI penny drop could be sent this consent: there is one, and it is no older than five minutes (nor in the future). */
export function upiConsentFresh(consent: { obtainedAt: Date } | null | undefined, now: Date): boolean {
  if (!consent || !(consent.obtainedAt instanceof Date) || Number.isNaN(consent.obtainedAt.getTime())) return false;
  const age = now.getTime() - consent.obtainedAt.getTime();
  return age >= -60_000 && age <= UPI_CONSENT_WINDOW_MS;
}

/**
 * A UPI ID as it is KEPT: the handle, and no more than the last four
 * characters before the `@` — `asha.rao@okhdfc` → `••••.rao@okhdfc`. A short
 * name shows fewer, so at least two characters always stay hidden.
 */
export function maskVpa(vpa: string | null | undefined): string | null {
  const clean = (vpa ?? '').trim();
  if (!clean) return null;
  const at = clean.lastIndexOf('@');
  const local = at >= 0 ? clean.slice(0, at) : clean;
  const handle = at >= 0 ? clean.slice(at) : '';
  const shown = Math.min(4, Math.max(0, local.length - 2));
  return `••••${shown > 0 ? local.slice(-shown) : ''}${handle}`;
}

/** "…1234" — the last four of a number, the rest never kept. Null for an empty value. */
export function lastFour(value: string | null | undefined): string | null {
  const clean = (value ?? '').replace(/\s+/g, '');
  if (!clean) return null;
  return `••••${clean.slice(-4)}`;
}
