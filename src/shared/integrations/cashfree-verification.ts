import { env } from '../../config/env';
import type { CheckContext, FetchLike } from '../verification/provider';
import { createSecureIdProvider } from '../verification/providers/cashfree-secure-id';
import type { BankAccountTransient, VehicleRcTransient } from '../verification/providers/cashfree-secure-id';
import { secureIdTuning } from '../verification/providers/secure-id-http';
import { failureOf, type BankAccountAnswer, type VehicleRcAnswer } from '../verification/routed-checks';
import { resolveVerificationSettings } from '../verification/settings';
import { newVerificationId } from '../verification/stores';

/**
 * Cashfree's Verification Suite — AG-4 (the owner, 20 Sep 2026): "for
 * vehicle verification and fetching details both for agents and publishers
 * putting their vehicle as ad spot", pointing at the vehicle-RC endpoint;
 * and the bank penny drop the payout rail has had a seam for since Lot B.
 *
 * Cashfree Phase 1 (1 Oct 2026): the two calls this file made grew into
 * the Secure ID provider (`shared/verification/providers/cashfree-secure-id.ts`)
 * and every caller now asks through the verification router
 * (`routedVehicleRc`, `routedBankAccount`), where the call is an attempt on
 * record with a breaker behind it. What is left here are the old exports as
 * THIN WRAPPERS over the provider — one direct call with the keys handed
 * in, no router, no record — and the shapes, re-exported from where they
 * moved. The wrappers keep the old answer: `ok: true` with the facts and
 * the raw payload, or `ok: false` with UNCONFIGURED, REFUSED or
 * UNAVAILABLE; nothing here throws.
 *
 *   Vehicle RC   POST /verification/vehicle-rc { verification_id, vehicle_number }
 *   Bank         POST /verification/bank-account/sync { bank_account, ifsc, name }
 *
 * (The first cut asked the RC with a GET and the number in the query;
 * Cashfree's API reference documents the POST above, with an id of ours.)
 */

export { VEHICLE_NUMBER_PATTERN, nameMatchScore, normaliseVehicleNumber, shapeBankAccount, shapeVehicleRc } from '../verification/providers/secure-id-shapes';
export type { BankAccountFacts, VehicleRcFacts } from '../verification/providers/secure-id-shapes';
export type { BankAccountAnswer, VehicleRcAnswer, VerificationFailure } from '../verification/routed-checks';
export type { FetchLike } from '../verification/provider';

export const CASHFREE_VERIFICATION_SANDBOX_HOST = 'https://sandbox.cashfree.com';
export const CASHFREE_VERIFICATION_LIVE_HOST = 'https://api.cashfree.com';
export const CASHFREE_VERIFICATION_TIMEOUT_MS = secureIdTuning.timeoutMs;

export type CashfreeVerificationConfig = { clientId?: string; clientSecret?: string; testMode: boolean };

/** The environment's pair alone — the running server reads `getEffectiveSecureIdConfig()`, which puts the settings row first. */
export function getCashfreeVerificationConfig(): CashfreeVerificationConfig {
  const testModeRaw = env.CASHFREE_VERIFICATION_TEST_MODE ?? env.CASHFREE_PAYOUT_TEST_MODE ?? 'true';
  const clientId = env.CASHFREE_VERIFICATION_CLIENT_ID ?? env.CASHFREE_PAYOUT_CLIENT_ID;
  const clientSecret = env.CASHFREE_VERIFICATION_CLIENT_SECRET ?? env.CASHFREE_PAYOUT_CLIENT_SECRET;
  return { ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}), testMode: testModeRaw.toLowerCase() !== 'false' };
}

export function cashfreeVerificationConfigured(cfg = getCashfreeVerificationConfig()): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

/** One direct call's context: an id of its own, the default settings, nothing recorded. */
const directContext = (fetchImpl: FetchLike | undefined): CheckContext => ({
  verificationId: newVerificationId(),
  attemptNo: 1,
  caseType: 'LISTING',
  caseId: 'direct',
  settings: resolveVerificationSettings(null),
  fetchImpl,
});

export async function lookupVehicleRc(vehicleNumber: string, fetchImpl?: FetchLike, cfg: CashfreeVerificationConfig = getCashfreeVerificationConfig()): Promise<VehicleRcAnswer> {
  const result = await createSecureIdProvider(() => cfg).run('VEHICLE_RC', { vehicleNumber }, directContext(fetchImpl));
  const answered = result.transient as VehicleRcTransient | undefined;
  return answered?.facts ? { ok: true, facts: answered.facts, raw: answered.raw } : failureOf({ result, skipped: [] });
}

export async function verifyBankAccount(
  input: { accountNumber: string; ifsc: string; name?: string | null; phone?: string | null },
  fetchImpl?: FetchLike,
  cfg: CashfreeVerificationConfig = getCashfreeVerificationConfig(),
): Promise<BankAccountAnswer> {
  const result = await createSecureIdProvider(() => cfg).run('BANK_ACCOUNT', { accountNumber: input.accountNumber, ifsc: input.ifsc, name: input.name, phone: input.phone, mode: 'SYNC' }, directContext(fetchImpl));
  const answered = result.transient as BankAccountTransient | undefined;
  return answered?.facts ? { ok: true, facts: answered.facts, raw: answered.raw } : failureOf({ result, skipped: [] });
}
