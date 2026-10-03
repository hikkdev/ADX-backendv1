import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Cashfree Secure ID's webhook, checked — Cashfree Phase 1.
 *
 * From the verified reference (the "canonical method"): the header
 * `x-webhook-signature` is Base64( HMAC-SHA256( `x-webhook-timestamp` + the
 * RAW request body, the Secure ID client secret ) ). The body is the bytes
 * as they arrived — never JSON parsed and written out again.
 *
 * Two things the payment gateway's hook did not do (the Phase 0 audit:
 * "no timestamp freshness check — any timestamp is accepted"):
 *   - a timestamp more than five minutes from now is refused, so a
 *     captured call cannot be replayed later;
 *   - the same event is handled once (`ProviderEvent`), keyed on the event
 *     type and the id it is about — Cashfree says the same webhook "might
 *     be sent more than once for the same event".
 *
 * Pure: the caller supplies the secret, the clock and the store.
 */

export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export type WebhookVerdict = { ok: true } | { ok: false; reason: 'NO_SECRET' | 'MISSING_HEADERS' | 'STALE' | 'MISMATCH' };

/** Cashfree's sample timestamp is in milliseconds; a ten-digit value is read as seconds. */
export function webhookTimestampMs(value: string | undefined): number | null {
  if (!value || !/^\d{9,16}$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return number < 1e12 ? number * 1000 : number;
}

export function secureIdWebhookSignature(timestamp: string, rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(timestamp).update(rawBody).digest('base64');
}

export function verifySecureIdWebhook(input: {
  rawBody: Buffer | string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string | undefined;
  now?: Date | undefined;
  toleranceMs?: number | undefined;
}): WebhookVerdict {
  // Unset, every call is refused: a verifier that waves everything through when unconfigured is worse than none.
  if (!input.secret) return { ok: false, reason: 'NO_SECRET' };
  if (!input.signature || !input.timestamp || input.rawBody === undefined) return { ok: false, reason: 'MISSING_HEADERS' };
  const at = webhookTimestampMs(input.timestamp);
  if (at === null) return { ok: false, reason: 'MISSING_HEADERS' };

  const expected = Buffer.from(secureIdWebhookSignature(input.timestamp, input.rawBody, input.secret));
  const given = Buffer.from(input.signature.trim());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'MISMATCH' };

  // Checked after the signature, so only Cashfree's own old calls are told they are stale.
  const drift = Math.abs((input.now ?? new Date()).getTime() - at);
  if (drift > (input.toleranceMs ?? WEBHOOK_TOLERANCE_MS)) return { ok: false, reason: 'STALE' };
  return { ok: true };
}

export type SecureIdEvent = { eventType: string; eventId: string; data: Record<string, unknown> };

/**
 * `{ event_type, event_time, version, data }` read into the event and the
 * key it is de-duplicated on: the type and the id the event is about — our
 * `verification_id` (DigiLocker) or `user_id` (the async bank check), else
 * Cashfree's `reference_id`. Null for a body that is not an event.
 */
export function parseSecureIdEvent(body: unknown): SecureIdEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const eventType = typeof source['event_type'] === 'string' ? source['event_type'].trim() : '';
  const data = source['data'] && typeof source['data'] === 'object' && !Array.isArray(source['data']) ? (source['data'] as Record<string, unknown>) : null;
  if (!eventType || !data) return null;
  const idOf = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null;
  };
  const subject = idOf('verification_id') ?? idOf('user_id') ?? idOf('reference_id') ?? idOf('ref_id');
  if (!subject) return null;
  return { eventType, eventId: `${eventType}:${subject}`.slice(0, 190), data };
}
