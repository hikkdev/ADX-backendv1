import crypto from 'crypto';
import { env } from '../../config/env';
import type { QrType } from '../../shared/database';

/**
 * QR tokens are HMAC-SHA256 signed payloads encoded as base64url:
 *
 *     base64url(JSON payload) + '.' + base64url(HMAC signature)
 *
 * That makes them opaque, tamper-proof, and resolvable only by this backend.
 */

const QR_SECRET = env.QR_SECRET;

export type QrPayload = {
  id: string; // QrCode.id
  type: QrType;
  refId: string;
  iat: number; // issued at (unix ms)
};

export function sign(payload: QrPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', QR_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verify(token: string): QrPayload {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid QR token format');
  const [data, sig] = parts as [string, string];
  const expected = crypto.createHmac('sha256', QR_SECRET).update(data).digest('base64url');
  // timingSafeEqual, not ===, so signature comparison leaks no timing signal.
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(expected, 'base64url'))) {
    throw new Error('Invalid QR token signature');
  }
  return JSON.parse(Buffer.from(data, 'base64url').toString()) as QrPayload;
}
