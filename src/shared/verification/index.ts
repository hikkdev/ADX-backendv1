/**
 * The verification layer — Cashfree Phase 1 (the owner, 1 Oct 2026).
 *
 * Digio stays the primary KYC provider; Cashfree Secure ID is its automatic
 * backup and the provider of every single check. Callers name a check and a
 * case (`runCheck`), never a provider; the router picks from the settings,
 * fails over only when a provider could not answer, records every attempt,
 * and keeps a breaker per provider. See `router.ts` for the rules and
 * `hosted-kyc.ts` for how a Digio start becomes a Cashfree session.
 *
 * Imports no module. `bootstrap/register-modules.ts` wires the Postgres
 * stores, the Redis breaker and the settings row (`wireVerification`); an
 * unwired process runs on memory with the defaults.
 */
export * from './checks';
export * from './composites';
export * from './settings';
export * from './provider';
export * from './stores';
export * from './breaker';
export * from './runtime';
export * from './router';
export * from './hosted-kyc';
export * from './routed-checks';
export * from './webhook';
export { prismaAttemptStore, prismaProviderEventStore, prismaSessionStore } from './prisma-stores';
export { digioProvider, classifyDigioError, digioUniqueRequestId, vpaResult } from './providers/digio';
export {
  DIGILOCKER_CONSENT_GONE,
  bankResultOf,
  cashfreeSecureIdProvider,
  createSecureIdProvider,
  digilockerDocument,
  digilockerResultFromEvent,
  secureIdCapabilities,
} from './providers/cashfree-secure-id';
export type { BankAccountTransient, DigilockerDocumentRead, ReversePennyDropTransient, VehicleRcTransient } from './providers/cashfree-secure-id';
export {
  SECURE_ID_API_VERSION,
  SECURE_ID_LIVE_BASE,
  SECURE_ID_SANDBOX_BASE,
  cfSignature,
  classifySecureIdError,
  secureIdCall,
  secureIdConfigured,
  secureIdTuning,
} from './providers/secure-id-http';
export type { SecureIdAnswer, SecureIdKeys } from './providers/secure-id-http';
export { VEHICLE_NUMBER_PATTERN, nameMatchScore, normaliseVehicleNumber, shapeBankAccount, shapeVehicleRc } from './providers/secure-id-shapes';
export type { BankAccountFacts, VehicleRcFacts } from './providers/secure-id-shapes';

import type { CheckType, VerificationProviderName } from './checks';
import { verificationRuntime } from './runtime';
import type { VerificationSettings } from './settings';

/** The checks a provider can answer under these settings — for the settings screen's grid. */
export function providerCapabilities(name: VerificationProviderName, settings: VerificationSettings): CheckType[] {
  return verificationRuntime().providers[name].capabilities(settings);
}
