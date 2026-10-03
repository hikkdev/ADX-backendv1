import { logger } from './logger';

/**
 * 28 Sep 2026 (the owner pasted a Redis outage's log: four or five warnings
 * per request, "Request latency not recorded", "Request outcome not counted",
 * … thousands of lines that buried the one line that mattered): the same
 * warning is written once per window, and the next one it lets through says
 * how many were held back. Keyed by the message, so different warnings never
 * hide each other.
 */
const WINDOW_MS = 60_000;
const seen = new Map<string, { at: number; held: number }>();

function throttled(level: 'warn' | 'error', message: string, meta: Record<string, unknown> | undefined, now: number): void {
  const entry = seen.get(message);
  if (entry && now - entry.at < WINDOW_MS) {
    entry.held += 1;
    return;
  }
  const held = entry?.held ?? 0;
  seen.set(message, { at: now, held: 0 });
  logger[level](message, held > 0 ? { ...meta, repeatedSinceLast: held } : meta);
}

export const warnThrottled = (message: string, meta?: Record<string, unknown>, now = Date.now()): void => throttled('warn', message, meta, now);
export const errorThrottled = (message: string, meta?: Record<string, unknown>, now = Date.now()): void => throttled('error', message, meta, now);

/** Tests only: forget every window. */
export function resetThrottleForTests(): void {
  seen.clear();
}
