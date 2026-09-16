import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../../config/env';

/**
 * The time-limited link a scheduled report is mailed as — Lot G (Q143).
 *
 * A recipient is an address, not necessarily an account, so the link has
 * to carry its own authority: `<expiry>.<hmac>` over the run id and the
 * expiry, keyed on the access-token secret. It stops working at the run's
 * `expiresAt` (thirty days) and says nothing about who opened it — the run
 * row is the record of what was in it, and the file is a report, not a
 * document about a person.
 */

const sign = (runId: string, expiresAtMs: number): string =>
  createHmac('sha256', env.JWT_ACCESS_SECRET).update(`report-run:${runId}:${expiresAtMs}`).digest('base64url');

export function runFileToken(runId: string, expiresAt: Date): string {
  const ms = expiresAt.getTime();
  return `${ms}.${sign(runId, ms)}`;
}

/** True only for a token minted for this run that has not yet expired. */
export function verifyRunFileToken(runId: string, token: string, now = new Date()): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const ms = Number(token.slice(0, dot));
  if (!Number.isFinite(ms) || ms <= now.getTime()) return false;
  const expected = Buffer.from(sign(runId, ms));
  const given = Buffer.from(token.slice(dot + 1));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function publicBaseUrl(): string {
  return (env.BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');
}

export function runFileUrl(runId: string, expiresAt: Date): string {
  return `${publicBaseUrl()}/api/v1/reports/runs/${runId}/file?t=${encodeURIComponent(runFileToken(runId, expiresAt))}`;
}
