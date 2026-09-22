import { getEffectiveLeadChannelsConfig, type WhatsAppChannelConfig } from '../integrations/integration-config';
import { logger } from '../logging/logger';
import { GRAPH_BASE, graphError, verifyMetaWebhook } from './meta';
import {
  asArray,
  asRecord,
  epochToDate,
  OutreachWebhookRejected,
  str,
  type AdapterDescription,
  type SendOutcome,
  type TemplateSend,
  type TextSend,
  type WebhookEvent,
  type WebhookInput,
} from './types';

/**
 * WhatsApp — D5: BSP-selectable. Gupshup and Interakt are the two Indian
 * BSPs the owner named; Meta direct is the Cloud API. Free-form text is
 * allowed only inside the 24-hour window after the lead's last message;
 * outside it only an approved template goes — the hub decides which, the
 * adapter sends what it is handed.
 *
 *   Gupshup:  https://docs.gupshup.io/reference/msg  (form-encoded, `apikey` header)
 *   Interakt: https://docs.interakt.shop/api-reference  (JSON, Basic auth on the key)
 *   Meta:     https://developers.facebook.com/docs/whatsapp/cloud-api  (JSON, bearer token)
 */
export const GUPSHUP_BASE = 'https://api.gupshup.io/wa/api/v1';
export const INTERAKT_BASE = 'https://api.interakt.ai/v1/public';

type Fetch = typeof fetch;

export function describeWhatsApp(cfg: WhatsAppChannelConfig | undefined): AdapterDescription {
  const bsp = cfg?.bsp ?? null;
  const need = (fields: (keyof WhatsAppChannelConfig)[]) => fields.filter((f) => !cfg?.[f]).map(String);
  if (bsp === 'GUPSHUP') {
    const missing = need(['apiKey', 'appName', 'sourceNumber']);
    return { configured: missing.length === 0, provider: 'gupshup', missing };
  }
  if (bsp === 'INTERAKT') {
    const missing = need(['apiKey']);
    return { configured: missing.length === 0, provider: 'interakt', missing };
  }
  if (bsp === 'META') {
    const missing = need(['phoneNumberId', 'accessToken']);
    return { configured: missing.length === 0, provider: 'meta', missing };
  }
  return { configured: false, provider: null, missing: ['bsp'] };
}

/** Digits only — every BSP takes the number without the plus. */
export const waNumber = (value: string): string => value.replace(/[^\d]/g, '');

/** The approved template's values in the BSP's order: `params` names them, else the values in their own order. */
export function orderedValues(template: TemplateSend['template'], values: Record<string, string>): string[] {
  if (template.params && template.params.length > 0) return template.params.map((name) => values[name] ?? '');
  return Object.values(values);
}

/** The BSP's status vocabulary into ours; null for an event we do not track (enqueued, etc.). */
function statusOf(value: string | null): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null {
  switch ((value ?? '').toLowerCase()) {
    case 'sent':
    case 'message_api_sent':
      return 'SENT';
    case 'delivered':
    case 'message_api_delivered':
      return 'DELIVERED';
    case 'read':
    case 'message_api_read':
      return 'READ';
    case 'failed':
    case 'message_api_failed':
    case 'undelivered':
      return 'FAILED';
    default:
      return null;
  }
}

export function createWhatsAppAdapter(deps: { fetchImpl?: Fetch; config?: () => Promise<WhatsAppChannelConfig | undefined> } = {}) {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const config = deps.config ?? (async () => (await getEffectiveLeadChannelsConfig()).whatsapp);

  async function post(url: string, init: RequestInit, label: string): Promise<SendOutcome> {
    try {
      const response = await fetchImpl(url, init);
      const text = await response.text();
      if (!response.ok) {
        logger.warn(`WhatsApp ${label} refused`, { status: response.status, body: text.slice(0, 300) });
        return { ok: false, code: 'PROVIDER_ERROR', message: `${label}: HTTP ${response.status}` };
      }
      let data: Record<string, unknown> = {};
      try {
        data = asRecord(JSON.parse(text));
      } catch {
        /* a bare 200 */
      }
      const providerId =
        str(data['messageId']) ??
        str(asRecord(data['result'])['message_id']) ??
        str(asRecord(asArray(data['messages'])[0])['id']) ??
        str(data['id']) ??
        null;
      return { ok: true, providerId, response: text.slice(0, 500) };
    } catch (err) {
      logger.warn(`WhatsApp ${label} failed`, { reason: err instanceof Error ? err.message : String(err) });
      return { ok: false, code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    channel: 'WHATSAPP' as const,

    async describe(): Promise<AdapterDescription> {
      return describeWhatsApp(await config());
    },

    /** Free-form text — the hub sends this only inside the window. */
    async sendText(input: TextSend): Promise<SendOutcome> {
      const cfg = await config();
      const desc = describeWhatsApp(cfg);
      if (!desc.configured || !cfg) return { ok: false, code: 'NOT_CONFIGURED', message: `WhatsApp is not configured (${desc.missing.join(', ')} missing)` };
      const to = waNumber(input.to);
      if (cfg.bsp === 'GUPSHUP') {
        const form = new URLSearchParams({
          channel: 'whatsapp',
          source: waNumber(cfg.sourceNumber!),
          destination: to,
          'src.name': cfg.appName!,
          message: JSON.stringify({ type: 'text', text: input.text }),
        });
        return post(`${GUPSHUP_BASE}/msg`, { method: 'POST', headers: { apikey: cfg.apiKey!, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 'text');
      }
      if (cfg.bsp === 'INTERAKT') {
        return post(
          `${INTERAKT_BASE}/message/`,
          {
            method: 'POST',
            headers: { Authorization: `Basic ${cfg.apiKey!}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullPhoneNumber: `+${to}`, type: 'Text', data: { message: input.text } }),
          },
          'text',
        );
      }
      return post(
        `${GRAPH_BASE}/${encodeURIComponent(cfg.phoneNumberId!)}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.accessToken!}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: input.text } }),
        },
        'text',
      );
    },

    /** An approved template — the only thing that may go outside the window. */
    async sendTemplate(input: TemplateSend): Promise<SendOutcome> {
      const cfg = await config();
      const desc = describeWhatsApp(cfg);
      if (!desc.configured || !cfg) return { ok: false, code: 'NOT_CONFIGURED', message: `WhatsApp is not configured (${desc.missing.join(', ')} missing)` };
      const to = waNumber(input.to);
      const values = orderedValues(input.template, input.values);
      const language = input.template.language ?? 'en';
      if (cfg.bsp === 'GUPSHUP') {
        const form = new URLSearchParams({
          source: waNumber(cfg.sourceNumber!),
          destination: to,
          'src.name': cfg.appName!,
          template: JSON.stringify({ id: input.template.name, params: values }),
        });
        return post(`${GUPSHUP_BASE}/template/msg`, { method: 'POST', headers: { apikey: cfg.apiKey!, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 'template');
      }
      if (cfg.bsp === 'INTERAKT') {
        return post(
          `${INTERAKT_BASE}/message/`,
          {
            method: 'POST',
            headers: { Authorization: `Basic ${cfg.apiKey!}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullPhoneNumber: `+${to}`, type: 'Template', template: { name: input.template.name, languageCode: language, bodyValues: values } }),
          },
          'template',
        );
      }
      return post(
        `${GRAPH_BASE}/${encodeURIComponent(cfg.phoneNumberId!)}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.accessToken!}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
              name: input.template.name,
              language: { code: language },
              components: values.length > 0 ? [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }] : [],
            },
          }),
        },
        'template',
      );
    },

    /**
     * The three webhooks. Gupshup posts `{ type: 'message' | 'message-event', payload }`,
     * Interakt `{ type: 'message_received' | 'message_api_*', data }`, Meta the
     * Graph envelope (`object: 'whatsapp_business_account'`, signed). A BSP
     * that cannot be verified (no secret on file where one is expected) is
     * refused; Gupshup and Interakt carry no signature and are trusted on the
     * URL's secret the hub checks before calling here.
     */
    async parseWebhook(input: WebhookInput, now = new Date()): Promise<WebhookEvent[]> {
      const cfg = await config();
      const body = asRecord(input.body);
      const events: WebhookEvent[] = [];

      if (body['object'] === 'whatsapp_business_account') {
        verifyMetaWebhook(input, [cfg?.appSecret]);
        for (const entry of asArray(body['entry'])) {
          for (const change of asArray(asRecord(entry)['changes'])) {
            const value = asRecord(asRecord(change)['value']);
            const names = new Map<string, string>();
            for (const contact of asArray(value['contacts'])) {
              const c = asRecord(contact);
              const waId = str(c['wa_id']);
              const name = str(asRecord(c['profile'])['name']);
              if (waId && name) names.set(waId, name);
            }
            for (const message of asArray(value['messages'])) {
              const m = asRecord(message);
              const from = str(m['from']);
              const id = str(m['id']);
              if (!from || !id) continue;
              const text = str(asRecord(m['text'])['body']) ?? str(asRecord(m['button'])['text']) ?? str(asRecord(asRecord(m['interactive'])['button_reply'])['title']) ?? `[${str(m['type']) ?? 'media'}]`;
              events.push({ kind: 'MESSAGE', channel: 'WHATSAPP', providerThreadId: `wa:${from}`, providerMessageId: id, from, fromName: names.get(from) ?? null, text, at: epochToDate(m['timestamp'], now), source: 'DM' });
            }
            for (const status of asArray(value['statuses'])) {
              const s = asRecord(status);
              const id = str(s['id']);
              const mapped = statusOf(str(s['status']));
              if (!id || !mapped) continue;
              const error = str(asRecord(asArray(s['errors'])[0])['title']);
              events.push({ kind: 'STATUS', channel: 'WHATSAPP', providerMessageId: id, status: mapped, error: mapped === 'FAILED' ? (error ?? 'failed') : null, at: epochToDate(s['timestamp'], now) });
            }
          }
        }
        return events;
      }

      const type = str(body['type']) ?? '';
      // Gupshup
      if (type === 'message' || type === 'message-event') {
        const payload = asRecord(body['payload']);
        if (type === 'message') {
          const from = str(asRecord(payload['sender'])['phone']) ?? str(payload['source']);
          const id = str(payload['id']);
          if (!from || !id) return events;
          const text = str(asRecord(payload['payload'])['text']) ?? str(asRecord(payload['payload'])['title']) ?? `[${str(payload['type']) ?? 'media'}]`;
          events.push({ kind: 'MESSAGE', channel: 'WHATSAPP', providerThreadId: `wa:${from}`, providerMessageId: id, from, fromName: str(asRecord(payload['sender'])['name']), text, at: epochToDate(body['timestamp'], now), source: 'DM' });
        } else {
          const id = str(payload['gsId']) ?? str(payload['id']);
          const mapped = statusOf(str(payload['type']));
          if (id && mapped) events.push({ kind: 'STATUS', channel: 'WHATSAPP', providerMessageId: id, status: mapped, error: mapped === 'FAILED' ? (str(asRecord(payload['payload'])['reason']) ?? 'failed') : null, at: epochToDate(body['timestamp'], now) });
        }
        return events;
      }
      // Interakt
      if (type === 'message_received' || type.startsWith('message_api_')) {
        const data = asRecord(body['data']);
        const message = asRecord(data['message']);
        const customer = asRecord(data['customer']);
        const id = str(message['id']);
        if (!id) return events;
        if (type === 'message_received') {
          const from = `${str(customer['country_code'])?.replace('+', '') ?? ''}${str(customer['phone_number']) ?? ''}`.replace(/[^\d]/g, '');
          if (!from) return events;
          events.push({ kind: 'MESSAGE', channel: 'WHATSAPP', providerThreadId: `wa:${from}`, providerMessageId: id, from, fromName: str(asRecord(customer['traits'])['name']), text: str(message['message']) ?? '[media]', at: epochToDate(message['received_at_utc'], now), source: 'DM' });
        } else {
          const mapped = statusOf(type);
          if (mapped) events.push({ kind: 'STATUS', channel: 'WHATSAPP', providerMessageId: id, status: mapped, error: mapped === 'FAILED' ? (str(message['message_status_reason']) ?? 'failed') : null, at: epochToDate(message['received_at_utc'] ?? message['delivered_at_utc'], now) });
        }
        return events;
      }
      if (Object.keys(body).length === 0) throw new OutreachWebhookRejected('Empty WhatsApp webhook');
      return events;
    },
  };
}

export type WhatsAppAdapter = ReturnType<typeof createWhatsAppAdapter>;
export const whatsappAdapter: WhatsAppAdapter = createWhatsAppAdapter();
