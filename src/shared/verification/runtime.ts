import { createBreaker, memoryBreakerStore, type Breaker } from './breaker';
import type { VerificationProviderName } from './checks';
import type { VerificationProvider } from './provider';
import { cashfreeSecureIdProvider } from './providers/cashfree-secure-id';
import { digioProvider } from './providers/digio';
import { resolveVerificationSettings, type VerificationSettings } from './settings';
import { memoryAttemptStore, memoryEventStore, memorySessionStore, type AttemptStore, type ProviderEventStore, type SessionStore } from './stores';

/**
 * What the verification layer runs on — Cashfree Phase 1.
 *
 * The router, the sessions and the webhook reach their stores, the breaker
 * and the settings through this one object, so the layer never names
 * Postgres or Redis itself. `bootstrap/register-modules.ts` wires the real
 * ones (`wireVerification` with the Prisma stores, the Redis breaker and
 * the integrations row's settings). A process that never wires — a unit
 * test of a KYC service, a seed script — runs on memory with the default
 * settings: nothing is written anywhere, the backup is OFF, and every
 * check behaves exactly as the defaults say.
 */

export interface VerificationRuntime {
  attempts: AttemptStore;
  sessions: SessionStore;
  events: ProviderEventStore;
  breaker: Breaker;
  settings: () => Promise<VerificationSettings>;
  providers: Record<VerificationProviderName, VerificationProvider>;
}

function unwired(): VerificationRuntime {
  return {
    attempts: memoryAttemptStore(),
    sessions: memorySessionStore(),
    events: memoryEventStore(),
    breaker: createBreaker(memoryBreakerStore()),
    settings: async () => resolveVerificationSettings(null),
    providers: { DIGIO: digioProvider, CASHFREE_SECURE_ID: cashfreeSecureIdProvider },
  };
}

let current: VerificationRuntime = unwired();

export function verificationRuntime(): VerificationRuntime {
  return current;
}

/** Bootstrap's call (and a test's): replace any of the ports — or any one provider; the rest stay as they are. */
export function wireVerification(ports: Partial<Omit<VerificationRuntime, 'providers'>> & { providers?: Partial<VerificationRuntime['providers']> | undefined }): VerificationRuntime {
  current = { ...current, ...ports, providers: { ...current.providers, ...(ports.providers ?? {}) } };
  return current;
}

/** For tests: back to memory and the defaults. */
export function resetVerificationRuntime(): VerificationRuntime {
  current = unwired();
  return current;
}
