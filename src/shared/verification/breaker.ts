import { redis } from '../cache/redis';
import { logger } from '../logging';
import type { VerificationProviderName } from './checks';
import type { BreakerSettings } from './settings';

/**
 * The per-provider circuit breaker — Cashfree Phase 1.
 *
 * The audit's finding: "there is no circuit breaker or vendor-health
 * history anywhere" — the SMS router this layer is modelled on tries a dead
 * primary first every time. A person waiting on a KYC page should not pay a
 * fifteen-second timeout for a provider that has just failed five people.
 *
 *   CLOSED     the provider is asked.
 *   OPEN       `failures` technical failures inside `windowMinutes` opened
 *              it; the provider is skipped for `cooldownMinutes`.
 *   HALF-OPEN  the cooldown has passed: ONE caller is let through as a
 *              probe. Its success closes the breaker; its failure opens it
 *              for another cooldown. Everyone else is still skipped while
 *              the probe is out.
 *
 * The state is in Redis, so every instance sees the same breaker; when
 * Redis itself cannot be reached the same logic runs on a map in this
 * process — a breaker that only this instance knows about is still better
 * than none.
 *
 * Three keys per provider: the failure count (expires with the window), the
 * moment it opened, and the probe's claim (expires on its own, so a probe
 * that died does not hold the breaker half-open forever).
 */

export interface BreakerStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** True when the key was not there and is now ours. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** The count after adding one; the first add starts the key's life. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  del(...keys: string[]): Promise<void>;
}

export function memoryBreakerStore(clock: () => number = Date.now): BreakerStore {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const row = rows.get(key);
    if (!row) return null;
    if (row.expiresAt <= clock()) {
      rows.delete(key);
      return null;
    }
    return row;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      rows.set(key, { value, expiresAt: clock() + ttlSeconds * 1000 });
    },
    async setIfAbsent(key, value, ttlSeconds) {
      if (live(key)) return false;
      rows.set(key, { value, expiresAt: clock() + ttlSeconds * 1000 });
      return true;
    },
    async incr(key, ttlSeconds) {
      const row = live(key);
      if (!row) {
        rows.set(key, { value: '1', expiresAt: clock() + ttlSeconds * 1000 });
        return 1;
      }
      row.value = String(Number(row.value) + 1);
      return Number(row.value);
    },
    async del(...keys) {
      for (const key of keys) rows.delete(key);
    },
  };
}

/** Redis, with the in-process map standing in for any call Redis does not answer. */
export function redisBreakerStore(): BreakerStore {
  const fallback = memoryBreakerStore();
  let warned = false;
  const guarded = async <T>(viaRedis: () => Promise<T>, viaMemory: () => Promise<T>): Promise<T> => {
    try {
      return await viaRedis();
    } catch (err) {
      if (!warned) {
        warned = true;
        logger.warn('Verification breaker: Redis is not answering; keeping the breaker in this process', { reason: err instanceof Error ? err.message : String(err) });
      }
      return viaMemory();
    }
  };
  return {
    get: (key) => guarded(() => redis.get(key), () => fallback.get(key)),
    set: (key, value, ttl) => guarded(async () => void (await redis.set(key, value, 'EX', ttl)), () => fallback.set(key, value, ttl)),
    setIfAbsent: (key, value, ttl) => guarded(async () => (await redis.set(key, value, 'EX', ttl, 'NX')) === 'OK', () => fallback.setIfAbsent(key, value, ttl)),
    incr: (key, ttl) =>
      guarded(
        async () => {
          const count = await redis.incr(key);
          if (count === 1) await redis.expire(key, ttl);
          return count;
        },
        () => fallback.incr(key, ttl),
      ),
    del: (...keys) => guarded(async () => void (await redis.del(...keys)), () => fallback.del(...keys)),
  };
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
/** What a caller may do: ask (CLOSED), ask as the one probe (PROBE), or leave the provider alone (OPEN). */
export type BreakerPass = 'CLOSED' | 'PROBE' | 'OPEN';

export type BreakerView = { provider: VerificationProviderName; state: BreakerState; failures: number; openedAt: string | null; retryAt: string | null };

/** How long one probe may be out before another caller may probe instead. */
const PROBE_TTL_SECONDS = 60;
/** An open breaker nobody has asked about for a day is forgotten. */
const OPEN_TTL_SECONDS = 24 * 60 * 60;

export interface Breaker {
  pass(provider: VerificationProviderName, settings: BreakerSettings): Promise<BreakerPass>;
  success(provider: VerificationProviderName): Promise<void>;
  failure(provider: VerificationProviderName, settings: BreakerSettings): Promise<BreakerState>;
  view(provider: VerificationProviderName, settings: BreakerSettings): Promise<BreakerView>;
  reset(provider: VerificationProviderName): Promise<void>;
}

export function createBreaker(store: BreakerStore, clock: () => number = Date.now, prefix = 'verify:breaker'): Breaker {
  const keys = (provider: VerificationProviderName) => ({
    failures: `${prefix}:${provider}:failures`,
    opened: `${prefix}:${provider}:opened`,
    probe: `${prefix}:${provider}:probe`,
  });
  const cooldownMs = (settings: BreakerSettings) => settings.cooldownMinutes * 60_000;

  return {
    async pass(provider, settings) {
      const key = keys(provider);
      const opened = Number(await store.get(key.opened));
      if (!opened) return 'CLOSED';
      if (clock() - opened < cooldownMs(settings)) return 'OPEN';
      return (await store.setIfAbsent(key.probe, String(clock()), PROBE_TTL_SECONDS)) ? 'PROBE' : 'OPEN';
    },

    async success(provider) {
      const key = keys(provider);
      await store.del(key.failures, key.opened, key.probe);
    },

    async failure(provider, settings) {
      const key = keys(provider);
      // A probe that failed: open again for a whole cooldown.
      if (await store.get(key.opened)) {
        await store.set(key.opened, String(clock()), OPEN_TTL_SECONDS);
        await store.del(key.probe);
        return 'OPEN';
      }
      const count = await store.incr(key.failures, settings.windowMinutes * 60);
      if (count < settings.failures) return 'CLOSED';
      await store.set(key.opened, String(clock()), OPEN_TTL_SECONDS);
      await store.del(key.failures);
      logger.warn('Verification breaker opened', { provider, failures: count, windowMinutes: settings.windowMinutes, cooldownMinutes: settings.cooldownMinutes });
      return 'OPEN';
    },

    async view(provider, settings) {
      const key = keys(provider);
      const opened = Number(await store.get(key.opened));
      const failures = Number(await store.get(key.failures)) || 0;
      if (!opened) return { provider, state: 'CLOSED', failures, openedAt: null, retryAt: null };
      const retryAt = opened + cooldownMs(settings);
      return { provider, state: clock() < retryAt ? 'OPEN' : 'HALF_OPEN', failures, openedAt: new Date(opened).toISOString(), retryAt: new Date(retryAt).toISOString() };
    },

    async reset(provider) {
      const key = keys(provider);
      await store.del(key.failures, key.opened, key.probe);
    },
  };
}
