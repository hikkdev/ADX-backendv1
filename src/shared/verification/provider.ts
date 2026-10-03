import type { CheckInputs, CheckResult, CheckType, VerificationCaseType, VerificationProviderName } from './checks';
import type { VerificationSettings } from './settings';

/**
 * The verification provider port — Cashfree Phase 1.
 *
 * One shape for every provider so the router can pick a primary from the
 * settings and fall down a list without knowing who is behind either (the
 * arrangement `shared/sms/rail.ts` has for SMS operators). A provider does
 * four things: says which checks it can answer, says whether it has what it
 * needs to be asked, answers one check, and — for a check that cannot finish
 * in one call (DigiLocker waits on the person, an async bank check on the
 * bank) — reads the answer back later.
 *
 * A provider NEVER throws for something the vendor did: a timeout, a 5xx, a
 * refusal and a "this PAN is invalid" are all a `CheckResult` with status
 * FAILED and the error class that tells the router what to do next.
 */

/** Why a provider that can answer a check cannot be put this request. */
export type ProviderUnusable = 'NOT_CONFIGURED' | 'NEEDS_CONSENT';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CheckContext {
  /** The attempt's id — sent to the provider as its idempotency key (`verification_id`). */
  verificationId: string;
  attemptNo: number;
  caseType: VerificationCaseType;
  caseId: string;
  settings: VerificationSettings;
  /** Tests hand in a mocked `fetch`; nothing in the suite calls Cashfree or Digio. */
  fetchImpl?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

/** What a later read needs of the attempt it reads back. */
export interface PendingAttempt {
  checkType: CheckType;
  verificationId: string;
  providerRef: string | null;
  result: Record<string, unknown> | null;
}

export interface VerificationProvider {
  readonly name: VerificationProviderName;
  /** The checks this provider can answer under these settings (the UPI check is off until the owner picks one). */
  capabilities(settings: VerificationSettings): CheckType[];
  /** `false` means "do not try me" — no keys on file. The router skips it and records nothing. */
  configured(): Promise<boolean>;
  /**
   * Whether THIS request can be put to the provider, past the two questions
   * above — the reason when it cannot, and the router skips it as it skips an
   * unconfigured one (nothing recorded). Absent means any request will do.
   * Cashfree's UPI penny drop needs the holder's consent from the last five
   * minutes (`NEEDS_CONSENT`); Digio's VPA lookup has no mock, so it needs
   * keys of its own (`NOT_CONFIGURED`).
   */
  usable?<C extends CheckType>(check: C, input: CheckInputs[C], settings: VerificationSettings, now: Date): Promise<ProviderUnusable | null>;
  run<C extends CheckType>(check: C, input: CheckInputs[C], ctx: CheckContext): Promise<CheckResult>;
  /** Reads a PENDING / NEEDS_USER_ACTION attempt back. Absent on a provider whose checks all finish in one call. */
  refresh?(attempt: PendingAttempt, ctx: CheckContext): Promise<CheckResult>;
}

export const VERIFICATION_PROVIDER_LABELS: Record<VerificationProviderName, string> = {
  DIGIO: 'Digio',
  CASHFREE_SECURE_ID: 'Cashfree Secure ID',
};
