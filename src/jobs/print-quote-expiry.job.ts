import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { expireQuoteRequests } from '../modules/print-partners';

const TAG = 'printQuoteExpiryJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:print-quote-expiry-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:print-quote-expiry:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let printQuoteExpiryInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The nightly quote-request expiry — Lot H (Q147), a default awaiting the
 * owner's later round on deadlines.
 *
 * Every OPEN request past its deadline: with no quote and never re-invited,
 * the deadline moves out by the default window and every invited partner is
 * told once more; with no quote after that, EXPIRED and ops told; with
 * quotes standing, left OPEN for ops to award and ops reminded. Runs on an
 * hourly interval rather than a cron so a process that started at noon
 * still catches the day; the day lock is what makes it once.
 */
export async function printQuoteExpiryTick(now = new Date()): Promise<void> {
  recordHeartbeat('print-quote-expiry', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;
    const summary = await expireQuoteRequests(now);
    logger.info('Print quote requests expired', { tag: TAG, ...summary });
  } catch (err) {
    logger.error('printQuoteExpiryJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startPrintQuoteExpiryJob(): void {
  printQuoteExpiryInterval = setInterval(() => void printQuoteExpiryTick(), INTERVAL_MS);
}
