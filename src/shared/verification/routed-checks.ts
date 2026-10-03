import type { CheckInputs, CheckResult, VerificationCaseType, VerificationProviderName } from './checks';
import type { BankAccountTransient, VehicleRcTransient } from './providers/cashfree-secure-id';
import type { BankAccountFacts, VehicleRcFacts } from './providers/secure-id-shapes';
import { normaliseVehicleNumber } from './providers/secure-id-shapes';
import { runCheck, type RouteOptions, type RoutedCheck, type SkippedProvider } from './router';
import { verificationRuntime } from './runtime';

/**
 * The two checks ADX already made before the router existed — the vehicle
 * RC and the bank penny drop (AG-4) — asked THROUGH the router, answered in
 * the shape their callers have always read.
 *
 * `ok: true` carries the facts and the raw payload (kept on the caller's
 * own record, so a disputed check can be traced); `ok: false` says why not
 * — UNCONFIGURED (no provider has keys), REFUSED (the provider said no: an
 * unwhitelisted IP, a bad pair, a number it will not take) or UNAVAILABLE
 * (it did not answer, or its breaker is open). The caller decides what a
 * refusal means; nothing here throws. What is new is underneath: the call
 * is an attempt on record, counts towards the provider's breaker, and
 * would fail over if a second provider ever answered these checks.
 */

export type VerificationFailure = { ok: false; code: 'UNCONFIGURED' | 'REFUSED' | 'UNAVAILABLE'; message: string; status?: number };
export type VehicleRcAnswer = { ok: true; facts: VehicleRcFacts; raw: Record<string, unknown> } | VerificationFailure;
export type BankAccountAnswer = { ok: true; facts: BankAccountFacts; raw: Record<string, unknown> } | VerificationFailure;

/** What the check is about — whose attempt list it lands on. */
export type CheckSubject = { caseType: VerificationCaseType; caseId: string };

export const UNCONFIGURED_MESSAGE = 'Cashfree verification is not configured; check by hand.';

/** A result with no facts to hand back, read into the callers' three refusals. */
export function failureOf(routed: Pick<RoutedCheck, 'result' | 'skipped'>): VerificationFailure {
  const result = routed.result;
  if (!result) {
    return routed.skipped.some((skip) => skip.reason === 'CIRCUIT_OPEN')
      ? { ok: false, code: 'UNAVAILABLE', message: 'Cashfree has not been answering; it will be tried again shortly' }
      : { ok: false, code: 'UNCONFIGURED', message: UNCONFIGURED_MESSAGE };
  }
  const message = result.failureReason ?? 'The check could not be made';
  if (result.failureCode === 'NOT_CONFIGURED') return { ok: false, code: 'UNCONFIGURED', message: UNCONFIGURED_MESSAGE };
  if (result.errorClass === 'TIMEOUT' || result.errorClass === 'NETWORK') return { ok: false, code: 'UNAVAILABLE', message };
  const status = typeof result.raw['httpStatus'] === 'number' ? (result.raw['httpStatus'] as number) : undefined;
  return { ok: false, code: 'REFUSED', message, ...(status !== undefined ? { status } : {}) };
}

const factsOf = <T>(result: CheckResult | null): T | null => {
  const transient = result?.transient as { facts?: unknown } | undefined;
  return transient && typeof transient === 'object' && transient.facts ? (transient as T) : null;
};

/** The registration certificate behind a vehicle number. An RC the authority calls INVALID is still an answer: `ok: true`, `facts.status: 'INVALID'`. */
export async function routedVehicleRc(vehicleNumber: string, about: CheckSubject): Promise<VehicleRcAnswer> {
  const routed = await runCheck('VEHICLE_RC', { vehicleNumber: normaliseVehicleNumber(vehicleNumber) }, about);
  const answered = factsOf<VehicleRcTransient>(routed.result);
  return answered ? { ok: true, facts: answered.facts, raw: answered.raw } : failureOf(routed);
}

/** The bank's word on an account, with Cashfree's own name-match score when a name was sent. An account the bank calls INVALID is still an answer. */
export async function routedBankAccount(input: { accountNumber: string; ifsc: string; name?: string | null; phone?: string | null }, about: CheckSubject): Promise<BankAccountAnswer> {
  const routed = await runCheck('BANK_ACCOUNT', { accountNumber: input.accountNumber, ifsc: input.ifsc, name: input.name, phone: input.phone, mode: 'SYNC' }, about);
  const answered = factsOf<BankAccountTransient>(routed.result);
  return answered ? { ok: true, facts: answered.facts, raw: answered.raw } : failureOf(routed);
}

/* ── UPI ID ────────────────────────────────────────────────────── */

/**
 * The word on a UPI ID (2 Oct 2026): Digio's VPA lookup first, Cashfree's
 * penny drop second — the latter only when the holder has just consented
 * (the router skips it otherwise). Read into the five answers a payout
 * method needs:
 *
 *   VERIFIED       the ID is live and, when a name was sent, it matches
 *   NOT_FOUND      the ID is not active, or does not exist          (final)
 *   NAME_MISMATCH  the ID is live under another name — the score under
 *                  `nameMatchMin`, whichever provider scored it     (final)
 *   REFUSED        the provider answered no for another reason       (final)
 *   UNAVAILABLE    nobody could answer: no keys, no consent for the
 *                  backup, an outage, an open breaker               (try again)
 *
 * `via` is how a VERIFIED method is recorded: a name lookup (Digio) or a
 * penny drop (Cashfree). Nothing here throws.
 */
export type UpiVpaOutcome = 'VERIFIED' | 'NOT_FOUND' | 'NAME_MISMATCH' | 'REFUSED' | 'UNAVAILABLE';

export type UpiVpaAnswer = {
  outcome: UpiVpaOutcome;
  provider: VerificationProviderName | null;
  via: 'NAME_LOOKUP' | 'PENNY_DROP' | null;
  /** The name on the UPI ID, as the provider gave it. */
  nameAtBank: string | null;
  /** 0–100, when a name was sent and scored. */
  nameMatchScore: number | null;
  /** The provider's id for the call — kept on the method as its verification reference. */
  reference: string | null;
  failureCode: string | null;
  /** One sentence a person can read. */
  message: string;
  attemptId: string | null;
  skipped: SkippedProvider[];
  failedOver: boolean;
};

export const UPI_UNAVAILABLE_MESSAGE = 'This UPI ID could not be checked just now. Try again in a few minutes, or verify it by hand.';

const NOT_FOUND_CODES = new Set(['VPA_NOT_FOUND', 'UPI_INVALID', 'UPI_NOT_FOUND', 'UPI_INACTIVE']);

export async function routedUpiVpa(input: CheckInputs['UPI_VPA'], about: CheckSubject, options: Pick<RouteOptions, 'fetchImpl' | 'now'> = {}): Promise<UpiVpaAnswer> {
  const name = input.name?.trim() || undefined;
  const routed = await runCheck('UPI_VPA', { ...input, name }, { ...about, ...options });
  const { nameMatchMin } = await verificationRuntime().settings();
  const result = routed.result;
  const base = { attemptId: routed.attemptId, skipped: routed.skipped, failedOver: routed.failedOver };
  if (!result) {
    return { outcome: 'UNAVAILABLE', provider: null, via: null, nameAtBank: null, nameMatchScore: null, reference: null, failureCode: routed.skipped[0]?.reason ?? 'NO_PROVIDER', message: UPI_UNAVAILABLE_MESSAGE, ...base };
  }
  const nameAtBank = result.matchedName ?? null;
  const nameMatchScore = typeof result.nameMatchScore === 'number' ? result.nameMatchScore : null;
  const reference = result.provider === 'DIGIO' ? result.providerRef : (str(result.raw, 'referenceId') ?? str(result.raw, 'utr') ?? result.providerRef);
  const answered = { provider: result.provider, nameAtBank, nameMatchScore, reference, ...base };
  const mismatch = (): UpiVpaAnswer => ({
    outcome: 'NAME_MISMATCH',
    via: null,
    failureCode: 'NAME_MISMATCH',
    message: `The name on this UPI ID${nameAtBank ? ` (${nameAtBank})` : ''} does not match the account holder${nameMatchScore !== null ? ` — a match of ${nameMatchScore} out of 100` : ''}.`,
    ...answered,
  });

  if (result.status === 'VERIFIED') {
    // Whoever scored it, a name sent and scored under the bar is not a match.
    if (name && nameMatchScore !== null && nameMatchScore < nameMatchMin) return mismatch();
    return { outcome: 'VERIFIED', via: result.provider === 'DIGIO' ? 'NAME_LOOKUP' : 'PENNY_DROP', failureCode: null, message: 'The UPI ID is live and its name matches.', ...answered };
  }
  if (result.status === 'FAILED' && (result.errorClass ?? 'BUSINESS') === 'BUSINESS') {
    if (result.failureCode === 'NAME_MISMATCH') return mismatch();
    if (result.failureCode && NOT_FOUND_CODES.has(result.failureCode)) {
      return { outcome: 'NOT_FOUND', via: null, failureCode: result.failureCode, message: 'This UPI ID is not active, or does not exist.', ...answered };
    }
    return { outcome: 'REFUSED', via: null, failureCode: result.failureCode ?? null, message: result.failureReason ? `${result.failureReason}.` : 'The UPI ID was not confirmed.', ...answered };
  }
  // A technical failure on the last provider asked, or a check that would wait on the person (a reverse penny drop): no answer to record.
  return { outcome: 'UNAVAILABLE', via: null, failureCode: result.failureCode ?? result.status, message: UPI_UNAVAILABLE_MESSAGE, ...answered };
}

const str = (raw: Record<string, unknown> | null | undefined, key: string): string | null => {
  const value = raw?.[key];
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
};
