import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { expireSigningRequests } from '../modules/agreements';

const TAG = 'esignExpiryJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:esign-expiry-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;

export let esignExpiryInterval: ReturnType<typeof setInterval> | null = null;

/**
 * DS-1 (Digio eSign): the hourly sweep over open signing requests past
 * their expiry — EXPIRED, the signer told. Digio expires its own link at
 * the same moment; this is what keeps the desk's list and the app's
 * standing honest when the provider's webhook does not say so.
 */
export async function esignExpiryTick(now = new Date()): Promise<void> {
  recordHeartbeat('esign-expiry', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const summary = await expireSigningRequests(now);
    if (summary.expired > 0) logger.info('Signing requests expired', { tag: TAG, ...summary });
  } catch (err) {
    logger.error('esignExpiryJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startEsignExpiryJob(): void {
  esignExpiryInterval = setInterval(() => void esignExpiryTick(), INTERVAL_MS);
}
