import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runSignalScan } from '../modules/fraud';
import { listAdminUserIds, systemUserId } from '../modules/users';

const TAG = 'fraudSignalScanJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:fraud-signal-scan-tick';
const LOCK_TTL_MS = 55 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:fraud-signal-scan:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let fraudSignalScanInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The nightly fraud signal scan — Lot G (Q118/138), daily.
 *
 * Every party (bounded per type by `fraud.scanLimitPerType`) is run through
 * the signal registry; any signal above `fraud.scanThreshold` on a party
 * with no open case opens one — kind SIGNAL_SCAN, scored, the hot signals
 * in the summary — and every admin is told. It never suspends: a case is a
 * question, and a suspension is a person's answer to it.
 *
 * Hourly interval under a day lock, like the KYC purge, so a process that
 * started at noon still catches the day.
 */
export async function fraudSignalScanTick(now = new Date()): Promise<void> {
  recordHeartbeat('fraud-signal-scan', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;

    const actor = (await systemUserId()) ?? (await listAdminUserIds())[0];
    if (!actor) {
      logger.warn('Fraud signal scan skipped: no system or admin user to open cases under', { tag: TAG });
      return;
    }

    const report = await runSignalScan(actor, now);
    logger.info('Fraud signal scan done', { tag: TAG, scanned: report.scanned, opened: report.opened.length, alreadyOpen: report.alreadyOpen, threshold: report.threshold });
  } catch (err) {
    logger.error('fraudSignalScanJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startFraudSignalScanJob(): void {
  fraudSignalScanInterval = setInterval(() => void fraudSignalScanTick(), INTERVAL_MS);
}
