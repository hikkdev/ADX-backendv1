import { createHmac, createSign, randomUUID, timingSafeEqual } from 'crypto';
import { getEffectiveLeadChannelsConfig, type GoogleBusinessChannelConfig } from '../integrations/integration-config';
import { logger } from '../logging/logger';
import { asRecord, epochToDate, headerValue, OutreachWebhookRejected, str, type AdapterDescription, type SendOutcome, type TextSend, type WebhookEvent, type WebhookInput } from './types';

/**
 * Google Business Messages — the agent a business's Google listing chats
 * through. Google retired the public product in July 2024; the card stays
 * for a partner endpoint that still speaks the API (`apiBase` is fixed to
 * Google's host, a partner would front it). A service account signs a JWT
 * for a bearer token; the webhook is HMAC-SHA512 over the raw body keyed on
 * the partner key (`X-Goog-Signature`), and the first call is a handshake
 * (`{ clientToken, secret }` → echo `{ secret }`).
 *
 *   https://developers.google.com/business-communications/business-messages/reference/rest
 */
export const GBM_API_BASE = 'https://businessmessages.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/businessmessages';

type Fetch = typeof fetch;

export function describeGoogleBusiness(cfg: GoogleBusinessChannelConfig | undefined): AdapterDescription {
  const missing = (['agentId', 'serviceAccountJson', 'partnerKey'] as const).filter((f) => !cfg?.[f]).map(String);
  return { configured: missing.length === 0, provider: 'google-business', missing };
}

const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The service account's signed JWT, exchanged for an hour's bearer token. */
export function serviceAccountJwt(serviceAccountJson: string, now = new Date()): string {
  const account = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string };
  if (!account.client_email || !account.private_key) throw new Error('The service account JSON needs client_email and private_key');
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(account.private_key))}`;
}

export function gbmSignature(partnerKey: string, rawBody: Buffer): string {
  return createHmac('sha512', partnerKey).update(rawBody).digest('base64');
}

export function createGoogleBusinessAdapter(deps: { fetchImpl?: Fetch; config?: () => Promise<GoogleBusinessChannelConfig | undefined> } = {}) {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const config = deps.config ?? (async () => (await getEffectiveLeadChannelsConfig()).googleBusiness);
  let token: { value: string; expiresAt: number } | null = null;

  async function bearer(cfg: GoogleBusinessChannelConfig, now = new Date()): Promise<string> {
    if (token && token.expiresAt > now.getTime() + 60_000) return token.value;
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(cfg.serviceAccountJson!, now) });
    const response = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (!response.ok) throw new Error(`Google token refused: HTTP ${response.status}`);
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Google token answer carried no access_token');
    token = { value: data.access_token, expiresAt: now.getTime() + (data.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  return {
    channel: 'GOOGLE_BUSINESS' as const,

    async describe(): Promise<AdapterDescription> {
      return describeGoogleBusiness(await config());
    },

    /** `to` is the conversation id Google handed us on the lead's first message. */
    async sendText(input: TextSend): Promise<SendOutcome> {
      const cfg = await config();
      const desc = describeGoogleBusiness(cfg);
      if (!desc.configured || !cfg) return { ok: false, code: 'NOT_CONFIGURED', message: `Google Business Messages is not configured (${desc.missing.join(', ')} missing)` };
      try {
        const messageId = randomUUID();
        const response = await fetchImpl(`${GBM_API_BASE}/conversations/${encodeURIComponent(input.to)}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await bearer(cfg)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId, representative: { representativeType: 'HUMAN' }, text: input.text }),
        });
        if (!response.ok) {
          logger.warn('Business Messages refused', { status: response.status });
          return { ok: false, code: 'PROVIDER_ERROR', message: `HTTP ${response.status}` };
        }
        const data = (await response.json()) as { name?: string; messageId?: string };
        return { ok: true, providerId: data.messageId ?? messageId, response: data.name ?? null };
      } catch (err) {
        return { ok: false, code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) };
      }
    },

    /** The handshake's answer when the body is one, else null. */
    handshake(body: unknown): { secret: string } | null {
      const b = asRecord(body);
      const secret = str(b['secret']);
      return str(b['clientToken']) && secret ? { secret } : null;
    },

    async parseWebhook(input: WebhookInput, now = new Date()): Promise<WebhookEvent[]> {
      const cfg = await config();
      if (!cfg?.partnerKey) throw new OutreachWebhookRejected('No Business Messages partner key is configured');
      if (!input.rawBody) throw new OutreachWebhookRejected('Business Messages webhook arrived without its raw body');
      const presented = Buffer.from(headerValue(input.headers, 'x-goog-signature') ?? '');
      const expected = Buffer.from(gbmSignature(cfg.partnerKey, input.rawBody));
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw new OutreachWebhookRejected('Business Messages signature mismatch');

      const body = asRecord(input.body);
      const conversationId = str(body['conversationId']);
      const message = asRecord(body['message']);
      const events: WebhookEvent[] = [];
      if (conversationId && Object.keys(message).length > 0) {
        const id = str(message['messageId']) ?? str(message['name']);
        if (id) {
          events.push({
            kind: 'MESSAGE',
            channel: 'GOOGLE_BUSINESS',
            providerThreadId: conversationId,
            providerMessageId: id,
            from: conversationId,
            fromName: str(asRecord(asRecord(body['context'])['userInfo'])['displayName']),
            text: str(message['text']) ?? '[attachment]',
            at: epochToDate(message['createTime'] ?? body['sendTime'], now),
            source: 'DM',
          });
        }
      }
      const receipts = asRecord(body['receipts']);
      for (const receipt of Array.isArray(receipts['receipts']) ? receipts['receipts'] : []) {
        const r = asRecord(receipt);
        const messageName = str(r['message']);
        const id = messageName ? messageName.split('/').pop() ?? null : null;
        const type = str(r['receiptType']);
        if (!id || !type) continue;
        const status = type === 'READ' ? 'READ' : type === 'DELIVERED' ? 'DELIVERED' : null;
        if (status) events.push({ kind: 'STATUS', channel: 'GOOGLE_BUSINESS', providerMessageId: id, status, error: null, at: epochToDate(body['sendTime'], now) });
      }
      return events;
    },
  };
}

export type GoogleBusinessAdapter = ReturnType<typeof createGoogleBusinessAdapter>;
export const googleBusinessAdapter: GoogleBusinessAdapter = createGoogleBusinessAdapter();
