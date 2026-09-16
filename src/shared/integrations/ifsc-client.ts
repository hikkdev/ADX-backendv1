import { redis } from '../cache/redis';
import { logger } from '../logging';

/**
 * The IFSC directory — Lot B (Q11/Q109).
 *
 * Razorpay publishes the RBI's IFSC list as a keyless public endpoint,
 * `https://ifsc.razorpay.com/<CODE>`: 200 with the branch for a code it knows,
 * 404 for one it does not. That is enough to tell a typo from a bank, which
 * is the whole of what a payout method needs before ops spends a penny drop
 * on it.
 *
 * Three answers, and the caller has to tell them apart:
 *
 *   found: true    the directory knows the code — bank and branch attached
 *   found: false   the directory answered, and does not know it
 *   null           the directory did not answer (down, slow, unreachable)
 *
 * The third fails OPEN. A bank account entry must not depend on a free
 * third-party service being up; the typed bank name stands, unverified, and
 * the row says so by leaving `ifscVerifiedAt` empty.
 *
 * Cached in Redis for thirty days: branches do not move, and every party in a
 * city types the same few dozen codes.
 */

export const IFSC_DIRECTORY_URL = 'https://ifsc.razorpay.com';
export const IFSC_TIMEOUT_MS = 3_000;
export const IFSC_CACHE_SECONDS = 30 * 24 * 60 * 60;
/** A miss is cached for a day: a code the directory does not know today may be a new branch tomorrow. */
const IFSC_MISS_CACHE_SECONDS = 24 * 60 * 60;

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export type IfscRecord = {
  ifsc: string;
  bank: string;
  branch: string;
  city: string;
  state: string;
  neft: boolean;
  imps: boolean;
  rtgs: boolean;
  found: true;
};

export type IfscMiss = { ifsc: string; found: false };
export type IfscAnswer = IfscRecord | IfscMiss;

type DirectoryRow = {
  IFSC?: string;
  BANK?: string;
  BRANCH?: string;
  CITY?: string;
  STATE?: string;
  NEFT?: boolean;
  IMPS?: boolean;
  RTGS?: boolean;
};

export const normaliseIfsc = (code: string): string => code.trim().toUpperCase();

const cacheKey = (code: string) => `ifsc:${code}`;

async function readCache(code: string): Promise<IfscAnswer | null> {
  try {
    const hit = await redis.get(cacheKey(code));
    return hit ? (JSON.parse(hit) as IfscAnswer) : null;
  } catch (err) {
    logger.warn('IFSC cache read failed', { code, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function writeCache(answer: IfscAnswer): Promise<void> {
  try {
    await redis.set(
      cacheKey(answer.ifsc),
      JSON.stringify(answer),
      'EX',
      answer.found ? IFSC_CACHE_SECONDS : IFSC_MISS_CACHE_SECONDS
    );
  } catch (err) {
    logger.warn('IFSC cache write failed', { code: answer.ifsc, err: err instanceof Error ? err.message : String(err) });
  }
}

/** One call to the directory, or null when it did not answer in time. */
export async function fetchIfsc(
  code: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = IFSC_TIMEOUT_MS
): Promise<IfscAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${IFSC_DIRECTORY_URL}/${encodeURIComponent(code)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return { ifsc: code, found: false };
    if (!response.ok) {
      logger.warn('IFSC directory answered badly', { code, status: response.status });
      return null;
    }
    const row = (await response.json()) as DirectoryRow;
    if (!row.BANK) return { ifsc: code, found: false };
    return {
      ifsc: row.IFSC ?? code,
      bank: row.BANK,
      branch: row.BRANCH ?? '',
      city: row.CITY ?? '',
      state: row.STATE ?? '',
      neft: row.NEFT !== false,
      imps: row.IMPS !== false,
      rtgs: row.RTGS !== false,
      found: true,
    };
  } catch (err) {
    logger.warn('IFSC directory did not answer', { code, err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The directory's answer for a code, from cache when it has one.
 *
 * A malformed code never reaches the network: it is a miss by construction,
 * and the directory would only say the same thing more slowly.
 */
export async function lookupIfsc(
  input: string,
  fetchImpl: typeof fetch = fetch
): Promise<IfscAnswer | null> {
  const code = normaliseIfsc(input);
  if (!IFSC_PATTERN.test(code)) return { ifsc: code, found: false };

  const cached = await readCache(code);
  if (cached) return cached;

  const answer = await fetchIfsc(code, fetchImpl);
  if (answer) await writeCache(answer);
  return answer;
}
