import { constants, publicEncrypt } from 'crypto';
import { logger } from '../../logging';
import type { ErrorClass } from '../checks';
import type { FetchLike } from '../provider';
import { str } from './secure-id-shapes';

/**
 * The Cashfree Secure ID wire — Cashfree Phase 1 (the owner, 1 Oct 2026).
 *
 * Coded from the verified API reference of 1 Oct 2026 (every path, header
 * and status there was checked against Cashfree's docs) and from nothing
 * else:
 *
 *   hosts     sandbox https://sandbox.cashfree.com/verification
 *             live    https://api.cashfree.com/verification
 *   headers   x-client-id, x-client-secret, x-api-version: 2024-12-01, and
 *             x-cf-signature whenever a public key is configured
 *   signature Base64( RSA-OAEP-SHA1( publicKey, "<clientId>.<unixSeconds>" ) )
 *
 * 2FA is always on at Cashfree, the sandbox included: either the server's
 * IP is whitelisted, or every call is signed with the account's public key.
 * A server whose outbound address moves (Render) cannot be whitelisted, so
 * the signature is what production uses; the header is sent ONLY when a
 * key is configured — Cashfree says not to send it under IP whitelisting.
 *
 * Every call has a timeout; only reads (GET) are retried, with a backoff —
 * a POST that timed out may have been taken, and asking again would spend
 * a second check. One log line per call: the check, the path, the status,
 * the error class and Cashfree's code — never the body, a name or a number.
 */

export const SECURE_ID_SANDBOX_BASE = 'https://sandbox.cashfree.com/verification';
export const SECURE_ID_LIVE_BASE = 'https://api.cashfree.com/verification';
/** The version Cashfree's own SDK sends on every call; it meets each endpoint's documented rule. */
export const SECURE_ID_API_VERSION = '2024-12-01';

/** Timeouts and the read backoff. A mutable object so a test can run with no waits. */
export const secureIdTuning = {
  timeoutMs: 10_000,
  /** The two face calls carry images. */
  uploadTimeoutMs: 20_000,
  readRetryDelaysMs: [300, 900] as number[],
};

export type SecureIdKeys = { clientId?: string | undefined; clientSecret?: string | undefined; publicKey?: string | undefined; testMode: boolean };

export const secureIdConfigured = (keys: SecureIdKeys): boolean => Boolean(keys.clientId && keys.clientSecret);
export const secureIdBase = (keys: SecureIdKeys): string => (keys.testMode ? SECURE_ID_SANDBOX_BASE : SECURE_ID_LIVE_BASE);

/**
 * `x-cf-signature`: the client id and the current Unix time in SECONDS,
 * joined by a period, encrypted with the account's public key — RSA-OAEP
 * with SHA-1 (and MGF1/SHA-1) — and Base64-encoded. Cashfree accepts one
 * for about five minutes, so a fresh one is made for every call. Throws on
 * a key that is not a PEM public key; the caller answers AUTH_CONFIG.
 */
export function cfSignature(clientId: string, publicKeyPem: string, now: Date = new Date()): string {
  const plain = `${clientId}.${Math.floor(now.getTime() / 1000)}`;
  return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(plain, 'utf8')).toString('base64');
}

export type SecureIdRequest = {
  /** For the log line and nothing else. */
  check: string;
  method: 'GET' | 'POST';
  /** Relative to the base, `/pan`. */
  path: string;
  query?: Record<string, string> | undefined;
  json?: Record<string, unknown> | undefined;
  /** Multipart (the two face calls); the boundary header is fetch's to set. */
  form?: FormData | undefined;
  verificationId?: string | undefined;
};

export type SecureIdOk = { ok: true; status: number; body: Record<string, unknown>; latencyMs: number };
export type SecureIdFailure = {
  ok: false;
  errorClass: ErrorClass;
  status: number | null;
  /** Cashfree's own `code`, or ours for a call that never left (`NOT_CONFIGURED`, `PUBLIC_KEY_INVALID`, `TIMEOUT`, `NETWORK`). */
  code: string | null;
  message: string;
  body: Record<string, unknown>;
  latencyMs: number;
};
export type SecureIdAnswer = SecureIdOk | SecureIdFailure;

/** 422s that mean the bank or NPCI behind Cashfree is down, not that the account is bad. */
const UPSTREAM_DOWN_CODES = new Set([
  'failed_at_bank',
  'npci_unavailable',
  'connection_timeout',
  'source_bank_declined',
  'imps_mode_fail',
  'benficiary_bank_offline',
  'beneficiary_bank_offline',
  'verification_already_under_process',
]);
/** 400s that are about the keys, not the question. */
const KEY_CODES = new Set(['x-client-id_missing', 'x-client-secret_missing', 'x-client-secret_value_invalid']);

/**
 * A non-2xx answer read into the layer's classes (reference §1.4).
 *
 *   401, 403                         AUTH_CONFIG  (a bad pair, an unwhitelisted IP, a missing signature)
 *   429                              RATE_LIMITED
 *   5xx                              HTTP_5XX     (Cashfree, or the source behind it)
 *   422 insufficient_balance         INSUFFICIENT_BALANCE
 *   422 bank / NPCI unavailable      HTTP_5XX     (the source is down; nothing was learned about the account)
 *   404 with no code                 NOT_ENABLED  (the product is not activated on the account — DigiLocker)
 *   400 "service not enabled"        NOT_ENABLED
 *   400 about the client id/secret   AUTH_CONFIG
 *   409 (the id was used before)     HTTP_5XX     (no answer was given; unreachable while ids are unique per attempt)
 *   every other 4xx                  BUSINESS     (Cashfree answered: the value is not valid)
 */
export function classifySecureIdError(status: number, body: Record<string, unknown>): ErrorClass {
  const code = str(body, 'code');
  const message = str(body, 'message') ?? '';
  if (status === 401 || status === 403) return 'AUTH_CONFIG';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'HTTP_5XX';
  if (status === 404) return code ? 'BUSINESS' : 'NOT_ENABLED';
  if (status === 409) return 'HTTP_5XX';
  if (status === 422) {
    if (code === 'insufficient_balance') return 'INSUFFICIENT_BALANCE';
    return code && UPSTREAM_DOWN_CODES.has(code) ? 'HTTP_5XX' : 'BUSINESS';
  }
  if (status === 400) {
    if (code && KEY_CODES.has(code)) return 'AUTH_CONFIG';
    if (/not enabled/i.test(message)) return 'NOT_ENABLED';
  }
  return 'BUSINESS';
}

const RETRIED_ON_READ: readonly ErrorClass[] = ['TIMEOUT', 'NETWORK', 'HTTP_5XX', 'RATE_LIMITED'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function once(request: SecureIdRequest, keys: SecureIdKeys, fetchImpl: FetchLike, now: Date): Promise<SecureIdAnswer> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const headers: Record<string, string> = {
    'x-client-id': keys.clientId!,
    'x-client-secret': keys.clientSecret!,
    'x-api-version': SECURE_ID_API_VERSION,
    Accept: 'application/json',
  };
  if (keys.publicKey) {
    try {
      headers['x-cf-signature'] = cfSignature(keys.clientId!, keys.publicKey, now);
    } catch {
      return { ok: false, errorClass: 'AUTH_CONFIG', status: null, code: 'PUBLIC_KEY_INVALID', message: 'The Secure ID public key on file is not a usable PEM public key', body: {}, latencyMs: elapsed() };
    }
  }
  if (request.json) headers['Content-Type'] = 'application/json';

  const query = request.query ? `?${new URLSearchParams(request.query).toString()}` : '';
  const timeoutMs = request.form ? secureIdTuning.uploadTimeoutMs : secureIdTuning.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${secureIdBase(keys)}${request.path}${query}`, {
      method: request.method,
      headers,
      ...(request.json ? { body: JSON.stringify(request.json) } : request.form ? { body: request.form } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (response.ok) return { ok: true, status: response.status, body, latencyMs: elapsed() };
    return {
      ok: false,
      errorClass: classifySecureIdError(response.status, body),
      status: response.status,
      code: str(body, 'code'),
      message: str(body, 'message') ?? `Cashfree answered ${response.status}`,
      body,
      latencyMs: elapsed(),
    };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      ok: false,
      errorClass: timedOut ? 'TIMEOUT' : 'NETWORK',
      status: null,
      code: timedOut ? 'TIMEOUT' : 'NETWORK',
      message: timedOut ? `Cashfree did not answer in ${timeoutMs / 1000}s` : err instanceof Error ? err.message : String(err),
      body: {},
      latencyMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Secure ID call. Never throws. A GET that failed for a reason another
 * try could cure is tried again after each delay in `readRetryDelaysMs`.
 */
export async function secureIdCall(
  request: SecureIdRequest,
  keys: SecureIdKeys,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  now: () => Date = () => new Date(),
): Promise<SecureIdAnswer> {
  if (!secureIdConfigured(keys)) {
    return { ok: false, errorClass: 'AUTH_CONFIG', status: null, code: 'NOT_CONFIGURED', message: 'Cashfree verification is not configured; check by hand.', body: {}, latencyMs: 0 };
  }
  const delays = request.method === 'GET' ? secureIdTuning.readRetryDelaysMs : [];
  let answer = await once(request, keys, fetchImpl, now());
  let tries = 1;
  for (const delay of delays) {
    if (answer.ok || !RETRIED_ON_READ.includes(answer.errorClass)) break;
    await sleep(delay);
    answer = await once(request, keys, fetchImpl, now());
    tries += 1;
  }
  // No personal data: the path carries no query, and Cashfree's message is
  // logged only for a key problem — where it names the IP to whitelist.
  const line = {
    check: request.check,
    method: request.method,
    path: request.path,
    status: answer.status,
    latencyMs: answer.latencyMs,
    tries,
    verificationId: request.verificationId ?? null,
    sandbox: keys.testMode,
    signed: Boolean(keys.publicKey),
    ...(answer.ok ? {} : { errorClass: answer.errorClass, code: answer.code, ...(answer.errorClass === 'AUTH_CONFIG' ? { reason: answer.message.slice(0, 200) } : {}) }),
  };
  if (answer.ok) logger.info('Secure ID call', line);
  else logger.warn('Secure ID call failed', line);
  return answer;
}
