import { createHmac, timingSafeEqual } from 'crypto';
import { getEffectiveTwilioConfig } from '../../integrations/integration-config';
import { logger } from '../../logging/logger';
import {
  headerValue,
  toE164,
  WebhookRejected,
  type DeliveryReport,
  type DeliveryWebhookInput,
  type SmsRail,
  type SmsSendRequest,
  type SmsSendResult,
} from '../rail';

/**
 * Twilio — the Messages API. Docs: https://www.twilio.com/docs/messaging/api/message-resource
 *
 * Twilio does not render templates: it is sent the text, and for an Indian
 * destination it matches that text against the DLT registration on its side.
 * So the body on the wire is the registered text rendered from the kind's
 * registration (`SmsKindRegistration.body`), and the DLT entity and template
 * ids ride along in the request so the operator can match the message to the
 * registration without guessing.
 *
 * The From is the DLT header (a six-letter sender id) when one is registered,
 * and the Twilio number otherwise.
 */

const API_BASE = 'https://api.twilio.com/2010-04-01/Accounts';

/** Twilio's status vocabulary into ours. */
function statusFrom(twilioStatus: string | undefined): DeliveryReport['status'] {
  switch ((twilioStatus ?? '').toLowerCase()) {
    case 'delivered':
    case 'read':
      return 'DELIVERED';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'FAILED';
    default:
      return 'SENT';
  }
}

/**
 * Twilio's request signature: HMAC-SHA1 over the URL with every POST
 * parameter appended, sorted by name, keyed on the auth token, base64.
 * Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

type Fetch = typeof fetch;

export function createTwilioRail(deps: { fetchImpl?: Fetch } = {}): SmsRail {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    name: 'twilio',

    async describe() {
      const { accountSid, authToken, phoneNumber } = await getEffectiveTwilioConfig();
      return { configured: Boolean(accountSid && authToken && phoneNumber) };
    },

    async send(request: SmsSendRequest): Promise<SmsSendResult> {
      const { accountSid, authToken, phoneNumber } = await getEffectiveTwilioConfig();
      if (!accountSid || !authToken) throw new Error('Twilio is not configured');
      const from = request.dlt.senderId ?? phoneNumber;
      if (!from) throw new Error('Twilio has no sender: set a DLT sender id or a Twilio number');
      if (!request.body) throw new Error(`Twilio needs the registered text for ${request.kind}`);

      const form = new URLSearchParams({
        To: toE164(request.to),
        From: from,
        Body: request.body,
        ...(request.dlt.entityId ? { DltEntityId: request.dlt.entityId } : {}),
        DltTemplateId: request.registration.templateId,
      });

      const response = await fetchImpl(`${API_BASE}/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
        body: form.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error('Twilio send failed', { kind: request.kind, status: response.status, body: text });
        throw new Error(`SMS delivery failed: ${response.status}`);
      }

      const data = (await response.json()) as { sid?: string; status?: string };
      logger.info('SMS sent via Twilio', { kind: request.kind, status: data.status });
      // Lot G (Q121): only the fields the log can use — Twilio's full body repeats the message text.
      return { providerMessageId: data.sid ?? null, responseText: JSON.stringify({ sid: data.sid ?? null, status: data.status ?? null }) };
    },

    /**
     * A status callback is a form post — MessageSid, MessageStatus, ErrorCode —
     * signed with the auth token. No token on file means nothing can be
     * verified, and a report nobody can verify is refused rather than trusted.
     */
    async parseDeliveryWebhook(input: DeliveryWebhookInput): Promise<DeliveryReport[]> {
      const { authToken } = await getEffectiveTwilioConfig();
      if (!authToken) throw new WebhookRejected('Twilio auth token is not configured');

      const params: Record<string, string> = {};
      if (input.body && typeof input.body === 'object') {
        for (const [key, value] of Object.entries(input.body as Record<string, unknown>)) {
          if (typeof value === 'string') params[key] = value;
        }
      }

      const presented = headerValue(input.headers, 'x-twilio-signature') ?? '';
      const expected = twilioSignature(authToken, input.url, params);
      const a = Buffer.from(presented);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new WebhookRejected('Twilio signature mismatch');
      }

      const sid = params['MessageSid'] ?? params['SmsSid'];
      if (!sid) return [];
      const status = statusFrom(params['MessageStatus'] ?? params['SmsStatus']);
      const error = params['ErrorMessage'] ?? (params['ErrorCode'] ? `Twilio error ${params['ErrorCode']}` : undefined);
      return [{ providerMessageId: sid, status, ...(status === 'FAILED' && error ? { error } : {}) }];
    },
  };
}

export const twilioRail: SmsRail = createTwilioRail();
