import { redis } from '../cache/redis';
import { logger } from '../logging/logger';

/**
 * The 5xx-rate alert.
 *
 * One 500 is a bug; ten in a minute is an outage, and the people who can act
 * on it are the admins in the console. Every server error the handler emits
 * is counted here in a per-minute Redis key (shared across instances, like
 * the rate limiters), and the first minute to cross the threshold raises one
 * alert — then nothing for fifteen minutes, however bad it gets, because a
 * notification per error is how an outage becomes a notification outage.
 *
 * shared/ cannot import the notifications module, so the alert leaves through
 * a port: bootstrap registers a callback that fans the alert out to the
 * admins, and this file only knows the shape.
 */

export const SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE = 10;
const ALERT_COOLDOWN_SECONDS = 15 * 60;
const COUNTER_TTL_SECONDS = 120;
const COUNTER_PREFIX = 'errors:5xx:';
const ALERTED_KEY = 'errors:5xx:alerted';
/** E6: one hash, one field per IST day, for the 30-day history the ops page reads. */
export const DAILY_5XX_KEY = 'errors:5xx:days';
export const DAILY_5XX_HISTORY_DAYS = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar day an instant falls in, as `YYYY-MM-DD`. */
export function istDayKey(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * E6: the last N days of 5xx counts, oldest first, zero for a day with no
 * field. Fields older than the window are dropped on the way past so the
 * hash never grows beyond a few dozen entries.
 */
export async function readDailyServerErrors(now = new Date(), days = DAILY_5XX_HISTORY_DAYS): Promise<{ day: string; count: number }[]> {
  const stored = await redis.hgetall(DAILY_5XX_KEY);
  const window: { day: string; count: number }[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = istDayKey(new Date(now.getTime() - back * 24 * 60 * 60 * 1000));
    window.push({ day, count: Number(stored[day] ?? 0) || 0 });
  }
  const keep = new Set(window.map((entry) => entry.day));
  const stale = Object.keys(stored).filter((day) => !keep.has(day));
  if (stale.length > 0) {
    try {
      await redis.hdel(DAILY_5XX_KEY, ...stale);
    } catch {
      // Pruning is housekeeping; the window still answers.
    }
  }
  return window;
}

async function countServerErrorDay(now: Date): Promise<void> {
  try {
    await redis.hincrby(DAILY_5XX_KEY, istDayKey(now), 1);
  } catch (cause) {
    logger.warn('Daily 5xx count not recorded', { cause: cause instanceof Error ? cause.message : String(cause) });
  }
}

export interface ServerErrorSample {
  requestId?: string | undefined;
  path?: string | undefined;
  status: number;
  code?: string | undefined;
}

export interface ServerErrorAlert {
  /** Errors seen so far in the minute that tripped the alert. */
  count: number;
  threshold: number;
  windowStartedAt: Date;
  /** The error that crossed the line — a place to start looking. */
  sample: ServerErrorSample;
}

export interface ServerErrorAlertPort {
  alertAdmins(alert: ServerErrorAlert): Promise<void>;
}

let port: ServerErrorAlertPort | null = null;

/** Wired in bootstrap/register-modules. Null unregisters (tests). */
export function registerServerErrorAlertPort(next: ServerErrorAlertPort | null): void {
  port = next;
}

/**
 * Count one server error and alert if this minute has crossed the threshold.
 * Never throws and never blocks the response that carried the error: the
 * handler does not await it.
 */
export async function recordServerError(sample: ServerErrorSample): Promise<void> {
  await countServerErrorDay(new Date());
  try {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${COUNTER_PREFIX}${minute}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, COUNTER_TTL_SECONDS);
    if (count < SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE) return;

    const acquired = await redis.set(ALERTED_KEY, '1', 'EX', ALERT_COOLDOWN_SECONDS, 'NX');
    if (acquired !== 'OK') return;

    const alert: ServerErrorAlert = {
      count,
      threshold: SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE,
      windowStartedAt: new Date(minute * 60_000),
      sample,
    };
    logger.error('Server error rate above threshold', { count, threshold: alert.threshold, sample });
    if (port) await port.alertAdmins(alert);
  } catch (cause) {
    logger.warn('Server error rate alert failed', { cause: cause instanceof Error ? cause.message : String(cause) });
  }
}
