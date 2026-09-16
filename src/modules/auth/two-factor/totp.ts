import crypto from 'crypto';
import { env } from '../../../config/env';

/**
 * RFC 6238 TOTP, by hand — Lot K2.
 *
 * No otplib: the whole algorithm is HMAC-SHA1 over a 64-bit counter, four
 * bytes picked by the low nibble of the last byte, six decimal digits. Node's
 * crypto has everything it needs, and a dependency for forty lines is a
 * dependency somebody has to audit. The parameters are the ones every
 * authenticator app defaults to — SHA1, 30-second steps, 6 digits — because
 * an app that reads a different `algorithm=` out of the URI is the exception
 * and a person locked out by it is the rule.
 *
 * Pinned by the RFC's own test vectors in `__tests__/totp.test.ts`.
 *
 * The secret at rest is sealed with AES-256-GCM (`sealSecret` / `openSecret`)
 * under `TOTP_ENCRYPTION_KEY`, or a key derived from `JWT_ACCESS_SECRET` when
 * that is unset. The stored form is `iv:tag:ciphertext`, each base64.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step: a code typed as the clock ticks over, or on a phone half a minute out. */
export const TOTP_WINDOW = 1;
/** 20 random bytes — the 160-bit secret RFC 4226 recommends for SHA1. */
export const TOTP_SECRET_BYTES = 20;
export const TOTP_ISSUER = 'ADX';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* ── base32 (RFC 4648, no padding on the way out, tolerated on the way in) ── */

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ── the algorithm ─────────────────────────────────────────────── */

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP: HMAC-SHA1 over the big-endian counter, dynamically truncated. */
export function hotp(secret: Buffer, counter: number | bigint, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Which 30-second step a moment falls in. */
export function totpStep(atMs = Date.now(), stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

export function totp(secretBase32: string, atMs = Date.now(), options: { digits?: number; stepSeconds?: number } = {}): string {
  return hotp(base32Decode(secretBase32), totpStep(atMs, options.stepSeconds), options.digits);
}

/**
 * The step whose code this is, or null. Every candidate in the window is
 * compared in constant time and none short-circuits, so a wrong code costs
 * the same as a right one whichever step it would have matched.
 */
export function matchTotp(
  secretBase32: string,
  code: string,
  atMs = Date.now(),
  options: { window?: number; digits?: number } = {},
): number | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const window = options.window ?? TOTP_WINDOW;
  const typed = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(typed)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(atMs);
  const given = Buffer.from(typed);
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    const expected = Buffer.from(hotp(secret, step, digits));
    if (crypto.timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

/** `otpauth://totp/ADX:<label>?secret=…&issuer=ADX&digits=6&period=30` — what the QR encodes. */
export function otpauthUri(label: string, secretBase32: string, issuer = TOTP_ISSUER): string {
  const name = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${name}?${params.toString()}`;
}

/* ── the secret at rest ────────────────────────────────────────── */

/**
 * The 32-byte key: `TOTP_ENCRYPTION_KEY` as 64 hex characters or base64,
 * else SHA-256 of `JWT_ACCESS_SECRET` so development works unconfigured.
 * Production must set its own — rotating the JWT secret would otherwise
 * unseal nobody's authenticator.
 */
export function encryptionKey(): Buffer {
  const configured = env.TOTP_ENCRYPTION_KEY;
  if (configured) {
    const raw = /^[0-9a-fA-F]{64}$/.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
    if (raw.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must decode to 32 bytes');
    return raw;
  }
  return crypto.createHash('sha256').update(`totp:${env.JWT_ACCESS_SECRET}`).digest();
}

/** `iv:tag:ciphertext`, each base64 — AES-256-GCM. */
export function sealSecret(secretBase32: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function openSecret(sealed: string): string {
  const [iv, tag, ciphertext] = sealed.split(':');
  if (!iv || !tag || !ciphertext) throw new Error('Not a sealed secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
