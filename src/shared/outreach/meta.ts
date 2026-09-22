import { createHmac, timingSafeEqual } from 'crypto';
import { headerValue, OutreachWebhookRejected, type WebhookInput } from './types';

/**
 * What the three Meta channels share: the Graph host, the webhook signature
 * (`X-Hub-Signature-256`, HMAC-SHA256 over the raw bytes keyed on the app
 * secret) and the subscription handshake (`hub.verify_token` → echo
 * `hub.challenge`).
 */
export const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

export function metaSignature(appSecret: string, rawBody: Buffer): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** Verifies the post's signature against the secrets on file — any of the cards' (one Meta app usually signs for all three). */
export function verifyMetaWebhook(input: WebhookInput, appSecrets: readonly (string | undefined)[]): void {
  const secrets = appSecrets.filter((s): s is string => Boolean(s && s.trim()));
  if (secrets.length === 0) throw new OutreachWebhookRejected('No Meta app secret is configured');
  if (!input.rawBody) throw new OutreachWebhookRejected('Meta webhook arrived without its raw body');
  const presented = headerValue(input.headers, 'x-hub-signature-256') ?? '';
  const a = Buffer.from(presented);
  for (const secret of secrets) {
    const b = Buffer.from(metaSignature(secret, input.rawBody));
    if (a.length === b.length && timingSafeEqual(a, b)) return;
  }
  throw new OutreachWebhookRejected('Meta signature mismatch');
}

/** The GET handshake: the challenge to echo when the token matches one on file, else null. */
export function metaHandshake(query: Record<string, unknown>, verifyTokens: readonly (string | undefined)[]): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
  return verifyTokens.some((t) => t && t === token) ? challenge : null;
}

/** Graph's error body, cut to one line for the log. */
export async function graphError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string; code?: number } };
    return data.error?.message ? `${data.error.message}${data.error.code ? ` (${data.error.code})` : ''}` : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
