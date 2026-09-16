import { createHmac } from 'crypto';
import { env } from '../../config/env';
import { toE164 } from '../../shared/sms';

/**
 * How an address appears in the delivery log — Lot E (Q87).
 *
 * The log is read by support and must not be a directory of phone numbers,
 * so a row carries the address masked for the eye and hashed for the search:
 * `+91 98450 •••23`, `j***@x.com`, and a digest an exact address can be
 * looked up by. The raw address never lands in the table.
 *
 * Lot F (the Lot E verifier's minor): the digest is a **keyed HMAC-SHA256**
 * under the same secret the unsubscribe token is signed with, not a plain
 * SHA-256. An Indian mobile is ten digits — 10^10 candidates, a few minutes
 * of hashing on one laptop — so a leaked `NotificationDelivery` table with
 * plain hashes was a phone directory with one extra step. With the key the
 * table alone cannot be brute-forced: without the secret there is nothing
 * to compare a guess against, and the search (`?q=<address>`) still works
 * because the server hashes the query with the same key. Rows hashed before
 * this change do not match an address search any more; the mask still does.
 */

export function maskMobile(mobile: string): string {
  const e164 = toE164(mobile);
  const national = e164.startsWith('+91') ? e164.slice(3) : e164.replace(/^\+/, '');
  const country = e164.startsWith('+91') ? '+91' : `+${e164.slice(1, e164.length - national.length)}`;
  if (national.length < 6) return `${country} •••${national.slice(-2)}`;
  return `${country} ${national.slice(0, 5)} •••${national.slice(-2)}`;
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@');
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/**
 * The canonical form of an address, so the same person hashes the same way
 * however it was typed. G6: a PUSH delivery's "address" is the user id —
 * the devices behind it come and go — so it hashes as typed.
 */
export function canonicalRecipient(channel: 'EMAIL' | 'SMS' | 'PUSH', address: string): string {
  if (channel === 'PUSH') return address.trim();
  return channel === 'EMAIL' ? address.trim().toLowerCase() : toE164(address);
}

export function hashRecipient(channel: 'EMAIL' | 'SMS' | 'PUSH', address: string): string {
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${channel}:${canonicalRecipient(channel, address)}`).digest('hex');
}

/** G6: how a push delivery's recipient reads in the log — the device count, never a token. */
export function maskDevices(count: number): string {
  return `${count} device${count === 1 ? '' : 's'}`;
}

export function maskRecipient(channel: 'EMAIL' | 'SMS', address: string): string {
  return channel === 'EMAIL' ? maskEmail(address) : maskMobile(address);
}

/** Whether a search term is an address to hash rather than a fragment of a mask to match. */
export function looksLikeAddress(q: string): { channel: 'EMAIL' | 'SMS'; address: string } | null {
  const trimmed = q.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { channel: 'EMAIL', address: trimmed };
  if (/^\+?[\d\s-]{10,15}$/.test(trimmed) && trimmed.replace(/\D/g, '').length >= 10) return { channel: 'SMS', address: trimmed };
  return null;
}

/* E12-B: an address quoted inside free text — a provider's error message
   names the mailbox or the number it could not reach. Emails first, so a
   digit run inside a local part is not taken for a phone; then a ten-digit
   Indian mobile, with or without +91 / 91 / 0 in front and spaces or
   hyphens between the groups. A bare word boundary on each side keeps a
   longer id (a 64-hex hash, a cuid) from being read as a number. */
const EMAIL_IN_TEXT = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}/g;
const MOBILE_IN_TEXT = /(?<![\d@\w.+-])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d@\w.-])/g;

/** Free text with every email and every ten-digit / +91 number masked the way the recipient column is. */
export function maskAddressesIn(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (email) => maskEmail(email)).replace(MOBILE_IN_TEXT, (mobile) => maskMobile(mobile));
}
