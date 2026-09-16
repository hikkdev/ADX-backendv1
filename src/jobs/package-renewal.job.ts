import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runPackageRenewals } from '../modules/packages';

const TAG = 'packageRenewalJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:package-renewal-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:package-renewal:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let packageRenewalInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The daily package-renewal sweep — Lot J2 (6), the advertiser twin of
 * `publisher-subscription.job.ts`.
 *
 * Two duties, both in `packages.runPackageRenewals`: the reminder
 * `reminderLeadDays` before a package ends (once per sale; with auto-renew
 * on it says what the wallet will be charged), and — while the advertiser
 * policy's `autoRenew.allowed` is on — the renewal of every lapsed sale
 * whose advertiser asked for it, paid from their wallet through the same
 * debit and activation a purchase makes, or told once why it could not be.
 * The five-minute expiry in `campaign-lifecycle.job.ts` still flips the
 * lapsed row to EXPIRED; this buys the next term. Hourly interval, daily
 * lock, the same shape as the publisher sweep: a process that starts at
 * noon still catches the day, and the day key is what makes it once.
 *
 * Lot K (B2): the day key is written **after** the sweep returns, not
 * before it runs — a sweep that throws leaves no key, so the next hourly
 * tick the same day tries again rather than waiting for tomorrow. The
 * tick lock is what keeps two ticks off the same sweep meanwhile.
 */
export async function packageRenewalTick(now = new Date()): Promise<void> {
  recordHeartbeat('package-renewal', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const dayKey = DAY_KEY(istDay(now));
    if (await redis.get(dayKey)) return;
    const summary = await runPackageRenewals(now);
    await redis.set(dayKey, '1', 'EX', 60 * 60 * 36);
    logger.info('Package renewals swept', { tag: TAG, ...summary });
  } catch (err) {
    logger.error('packageRenewalJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startPackageRenewalJob(): void {
  packageRenewalInterval = setInterval(() => void packageRenewalTick(), INTERVAL_MS);
}
