import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { escalateAgedKycCases } from '../modules/kyc';
import { listAdminUserIds, systemUserId } from '../modules/users';

const TAG = 'kycEscalationJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:kyc-escalation-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:kyc-escalation:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let kycEscalationInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * KYC escalation by age — Lot G (Q127/142), daily.
 *
 * A publisher, advertiser or (Lot N) print partner case still PENDING after
 * `kyc.escalationSlaMultiplier` × `kyc.reviewSlaHours` (2 × 48 h by default)
 * is escalated to a member of the Compliance pool (source AGE), who is told;
 * the audit row is written under the system user. A case already escalated,
 * by whichever source, is left as it is.
 */
export async function kycEscalationTick(now = new Date()): Promise<void> {
  recordHeartbeat('kyc-escalation', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;

    const actor = (await systemUserId()) ?? (await listAdminUserIds())[0] ?? null;
    const report = await escalateAgedKycCases(actor, now);
    logger.info('KYC cases escalated by age', {
      tag: TAG,
      cutoff: report.cutoff,
      slaHours: report.slaHours,
      multiplier: report.multiplier,
      publishers: report.publishers.length,
      advertisers: report.advertisers.length,
      // Lot N: the print partner's queue walks the same night.
      printPartners: report.printPartners.length,
    });
  } catch (err) {
    logger.error('kycEscalationJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startKycEscalationJob(): void {
  kycEscalationInterval = setInterval(() => void kycEscalationTick(), INTERVAL_MS);
}
