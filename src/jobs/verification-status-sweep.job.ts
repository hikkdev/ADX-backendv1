import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { sweepVerification } from '../modules/kyc';

const TAG = 'verificationStatusSweepJob';
const INTERVAL_MS = 2 * 60 * 1000;
const LOCK_KEY = 'lock:verification-status-sweep-tick';
const LOCK_TTL_MS = 100 * 1000;

export let verificationStatusSweepInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Cashfree Phase 1 (1 Oct 2026): every two minutes, the verification
 * attempts still waiting on a person (DigiLocker) or on a provider (an
 * async bank check) are read back until they finish or are given up on, and
 * every Cashfree session past its time is EXPIRED.
 *
 * Cashfree sends a webhook for both, and the webhook is the fast road. This
 * is the one that always arrives: no webhook can reach a machine with no
 * public address (the Phase 0 audit found exactly that for payments), and a
 * webhook can be lost.
 */
export async function verificationStatusSweepTick(now = new Date()): Promise<void> {
  recordHeartbeat('verification-status-sweep', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;
  try {
    const report = await sweepVerification(now);
    if (report.settled > 0 || report.givenUp > 0 || report.sessionsExpired > 0) logger.info('Verification attempts swept', { tag: TAG, ...report });
  } catch (err) {
    logger.error('verificationStatusSweepJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startVerificationStatusSweepJob(): void {
  verificationStatusSweepInterval = setInterval(() => void verificationStatusSweepTick(), INTERVAL_MS);
}
