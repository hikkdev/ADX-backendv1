import { createHmac, timingSafeEqual } from 'crypto';
import { getEffectiveLeadChannelsConfig, type TelephonyChannelConfig } from '../integrations/integration-config';
import { logger } from '../logging/logger';
import { asRecord, epochToDate, headerValue, OutreachWebhookRejected, str, type AdapterDescription, type CallOutcome, type CallStatusEvent, type InboundCallEvent, type PlaceCallInput, type PlaceCallOutcome, type WebhookInput } from './types';

/**
 * Telephony — D5: Exotel, Knowlarity or Twilio Voice, chosen on the card.
 * Click-to-call rings the agent first, then the lead, and the lead sees a
 * masked number (one of the card's caller ids), never the agent's own. The
 * operator posts the call's end (outcome, duration, a recording URL when the
 * call was recorded) to the status callback; a missed call to the
 * missed-call number and an IVR key press arrive on their own hooks.
 *
 *   Exotel:     https://developer.exotel.com/api/make-a-call-api  (Basic auth key:token, form)
 *   Knowlarity: https://developer.knowlarity.com  (x-api-key + authorization, JSON)
 *   Twilio:     https://www.twilio.com/docs/voice/api/call-resource  (Basic auth sid:token, form; TwiML answers)
 */
type Fetch = typeof fetch;

export function describeTelephony(cfg: TelephonyChannelConfig | undefined): AdapterDescription {
  const provider = cfg?.provider ?? null;
  const need = (fields: (keyof TelephonyChannelConfig)[]) => fields.filter((f) => !cfg?.[f]).map(String);
  if (provider === 'EXOTEL') {
    const missing = need(['accountSid', 'apiKey', 'apiToken', 'subdomain']);
    return { configured: missing.length === 0, provider: 'exotel', missing };
  }
  if (provider === 'KNOWLARITY') {
    const missing = need(['apiKey', 'apiToken', 'subdomain']);
    return { configured: missing.length === 0, provider: 'knowlarity', missing };
  }
  if (provider === 'TWILIO') {
    const missing = need(['accountSid', 'apiToken']);
    return { configured: missing.length === 0, provider: 'twilio', missing };
  }
  return { configured: false, provider: null, missing: ['provider'] };
}

/** `+91XXXXXXXXXX` from whatever an Indian number was typed as. */
export function e164(value: string): string {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return value.startsWith('+') ? value : `+${digits}`;
}

const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Twilio's answer for a click-to-call: the consent line (when the call is recorded), then the dial to the lead on the masked number. */
export function answerTwiml(input: { consentLine: string | null; leadNumber: string; callerId: string; record: boolean; statusCallbackUrl: string }): string {
  const say = input.record && input.consentLine ? `<Say>${xmlEscape(input.consentLine)}</Say>` : '';
  const record = input.record ? ' record="record-from-answer-dual"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Dial callerId="${xmlEscape(input.callerId)}"${record} action="${xmlEscape(input.statusCallbackUrl)}"><Number>${xmlEscape(e164(input.leadNumber))}</Number></Dial></Response>`;
}

/** Twilio's answer on the IVR number: the greeting and the two prompts, one digit gathered and posted to `actionUrl`. */
export function ivrTwiml(input: { greeting: string; publisherPrompt: string; advertiserPrompt: string; actionUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="${xmlEscape(input.actionUrl)}" method="POST"><Say>${xmlEscape(input.greeting)}</Say><Say>${xmlEscape(input.publisherPrompt)}</Say><Say>${xmlEscape(input.advertiserPrompt)}</Say></Gather><Say>We did not get that. Goodbye.</Say></Response>`;
}

/** The outcome an operator's status word means; null while the call is still going. */
export function outcomeOf(status: string | null, durationSec: number | null, answeredBy: string | null = null): CallOutcome | null {
  const s = (status ?? '').toLowerCase().replace(/[-_ ]/g, '');
  if (answeredBy && /^machine/.test(answeredBy)) return 'VOICEMAIL';
  if (['busy'].includes(s)) return 'BUSY';
  if (['noanswer', 'notanswered', 'timeout', 'canceled', 'cancelled', 'failed', 'missed'].includes(s)) return 'NO_ANSWER';
  if (['completed', 'answer', 'answered', 'success'].includes(s)) return durationSec !== null && durationSec === 0 ? 'NO_ANSWER' : 'ANSWERED';
  return null;
}

/** Twilio's request signature — HMAC-SHA1 over the URL plus the sorted POST params, keyed on the auth token. */
export function twilioVoiceSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

function stringParams(body: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(body))) if (typeof value === 'string') params[key] = value;
  return params;
}

export function createTelephonyAdapter(deps: { fetchImpl?: Fetch; config?: () => Promise<TelephonyChannelConfig | undefined> } = {}) {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const config = deps.config ?? (async () => (await getEffectiveLeadChannelsConfig()).telephony);

  /**
   * A webhook is trusted when the operator signed it (Twilio) or when the
   * card's webhook secret rides in the URL (`?token=` — Exotel and Knowlarity
   * sign nothing). No secret on file with an unsigned operator: refused.
   */
  async function verify(input: WebhookInput): Promise<TelephonyChannelConfig> {
    const cfg = (await config()) ?? {};
    if (cfg.provider === 'TWILIO' && cfg.apiToken) {
      const presented = Buffer.from(headerValue(input.headers, 'x-twilio-signature') ?? '');
      const expected = Buffer.from(twilioVoiceSignature(cfg.apiToken, input.url ?? '', stringParams(input.body)));
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw new OutreachWebhookRejected('Twilio signature mismatch');
      return cfg;
    }
    if (!cfg.webhookSecret) throw new OutreachWebhookRejected('No telephony webhook secret is configured');
    const token = str(input.query?.['token']) ?? headerValue(input.headers, 'x-webhook-token') ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(cfg.webhookSecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OutreachWebhookRejected('Telephony webhook token mismatch');
    return cfg;
  }

  return {
    channel: 'CALL' as const,

    async describe(): Promise<AdapterDescription> {
      return describeTelephony(await config());
    },

    async placeCall(input: PlaceCallInput): Promise<PlaceCallOutcome> {
      const cfg = await config();
      const desc = describeTelephony(cfg);
      if (!desc.configured || !cfg) return { ok: false, code: 'NOT_CONFIGURED', message: `Telephony is not configured (${desc.missing.join(', ')} missing)` };
      if (!input.callerId) return { ok: false, code: 'NO_CALLER_ID', message: 'No masked number is set on the telephony card' };
      try {
        if (cfg.provider === 'EXOTEL') {
          const host = cfg.subdomain!.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const form = new URLSearchParams({
            From: e164(input.agentNumber),
            To: e164(input.leadNumber),
            CallerId: input.callerId,
            Record: input.record ? 'true' : 'false',
            StatusCallback: input.statusCallbackUrl,
            'StatusCallbackEvents[0]': 'terminal',
            StatusCallbackContentType: 'application/json',
          });
          const response = await fetchImpl(`https://${host}/v1/Accounts/${encodeURIComponent(cfg.accountSid!)}/Calls/connect.json`, {
            method: 'POST',
            headers: { Authorization: `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
          });
          if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: `Exotel: HTTP ${response.status}` };
          const data = (await response.json()) as { Call?: { Sid?: string } };
          if (!data.Call?.Sid) return { ok: false, code: 'PROVIDER_ERROR', message: 'Exotel answered without a call sid' };
          return { ok: true, providerCallId: data.Call.Sid, maskedNumber: input.callerId };
        }
        if (cfg.provider === 'KNOWLARITY') {
          const response = await fetchImpl('https://kpi.knowlarity.com/Basic/v1/account/call/makecall', {
            method: 'POST',
            headers: { 'x-api-key': cfg.apiKey!, authorization: cfg.apiToken!, 'Content-Type': 'application/json' },
            body: JSON.stringify({ k_number: cfg.subdomain, agent_number: e164(input.agentNumber), customer_number: e164(input.leadNumber), caller_id: input.callerId }),
          });
          if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: `Knowlarity: HTTP ${response.status}` };
          const data = (await response.json()) as { success?: { call_id?: string }; error?: { message?: string } };
          const id = data.success?.call_id;
          if (!id) return { ok: false, code: 'PROVIDER_ERROR', message: data.error?.message ?? 'Knowlarity answered without a call id' };
          return { ok: true, providerCallId: id, maskedNumber: input.callerId };
        }
        const form = new URLSearchParams({
          To: e164(input.agentNumber),
          From: input.callerId,
          Url: input.answerUrl,
          StatusCallback: input.statusCallbackUrl,
          StatusCallbackEvent: 'completed',
        });
        const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid!)}/Calls.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.apiToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: `Twilio: HTTP ${response.status}` };
        const data = (await response.json()) as { sid?: string };
        if (!data.sid) return { ok: false, code: 'PROVIDER_ERROR', message: 'Twilio answered without a call sid' };
        return { ok: true, providerCallId: data.sid, maskedNumber: input.callerId };
      } catch (err) {
        logger.warn('Click-to-call failed', { provider: cfg.provider, reason: err instanceof Error ? err.message : String(err) });
        return { ok: false, code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) };
      }
    },

    /** The status callback on a call we placed — each operator's own field names. */
    async parseStatus(input: WebhookInput): Promise<CallStatusEvent | null> {
      const cfg = await verify(input);
      const b = asRecord(input.body);
      const raw = JSON.stringify(b).slice(0, 1000);
      if (cfg.provider === 'EXOTEL') {
        const id = str(b['CallSid']);
        if (!id) return null;
        const duration = str(b['ConversationDuration']) ?? str(b['Duration']);
        const durationSec = duration === null ? null : Number(duration);
        const status = str(b['Status']);
        return { providerCallId: id, outcome: outcomeOf(status, durationSec), durationSec, recordingUrl: str(b['RecordingUrl']), final: status !== null && !['in-progress', 'ringing', 'queued'].includes(status), raw };
      }
      if (cfg.provider === 'KNOWLARITY') {
        const id = str(b['call_id']) ?? str(b['uuid']) ?? str(b['CallSid']);
        if (!id) return null;
        const duration = str(b['call_duration']) ?? str(b['duration']);
        const durationSec = duration === null ? null : Number(duration);
        const status = str(b['call_status']) ?? str(b['status']);
        return { providerCallId: id, outcome: outcomeOf(status, durationSec), durationSec, recordingUrl: str(b['resource_url']) ?? str(b['recording_url']), final: true, raw };
      }
      const id = str(b['CallSid']);
      if (!id) return null;
      const duration = str(b['DialCallDuration']) ?? str(b['CallDuration']);
      const durationSec = duration === null ? null : Number(duration);
      const status = str(b['DialCallStatus']) ?? str(b['CallStatus']);
      return { providerCallId: id, outcome: outcomeOf(status, durationSec, str(b['AnsweredBy'])), durationSec, recordingUrl: str(b['RecordingUrl']), final: status !== null && !['in-progress', 'ringing', 'queued', 'initiated'].includes(status), raw };
    },

    /** A missed call or an IVR key press — who called, which number, what they pressed. */
    async parseInbound(input: WebhookInput, now = new Date()): Promise<InboundCallEvent | null> {
      await verify(input);
      const b = asRecord(input.body);
      const q = input.query ?? {};
      const from = str(b['CallFrom']) ?? str(b['From']) ?? str(b['caller_id']) ?? str(b['from']) ?? str(q['CallFrom']) ?? str(q['From']) ?? str(q['caller_id']);
      if (!from) return null;
      const to = str(b['CallTo']) ?? str(b['To']) ?? str(b['called_number']) ?? str(b['to']) ?? str(q['CallTo']) ?? str(q['To']) ?? null;
      const providerCallId = str(b['CallSid']) ?? str(b['uuid']) ?? str(b['call_id']) ?? str(q['CallSid']) ?? null;
      const digitsRaw = str(b['Digits']) ?? str(b['digits']) ?? str(b['dtmf']) ?? str(q['digits']) ?? str(q['Digits']) ?? null;
      const digits = digitsRaw === null ? null : digitsRaw.replace(/[^\d*#]/g, '') || null;
      return { from: e164(from), to: to ? e164(to) : null, providerCallId, digits, at: epochToDate(b['StartTime'] ?? b['start_time'] ?? b['Timestamp'], now) };
    },

    /** Fetches a recording's bytes with the operator's own auth; null when the URL is not the operator's. */
    async fetchRecording(url: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
      const cfg = await config();
      if (!cfg?.provider) return null;
      const headers: Record<string, string> = {};
      if (cfg.provider === 'EXOTEL') headers['Authorization'] = `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString('base64')}`;
      if (cfg.provider === 'TWILIO') headers['Authorization'] = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.apiToken}`).toString('base64')}`;
      if (cfg.provider === 'KNOWLARITY') headers['x-api-key'] = cfg.apiKey ?? '';
      const target = cfg.provider === 'TWILIO' && !/\.(mp3|wav)$/i.test(url) ? `${url}.mp3` : url;
      const response = await fetchImpl(target, { headers });
      if (!response.ok) return null;
      const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg';
      return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
    },
  };
}

export type TelephonyAdapter = ReturnType<typeof createTelephonyAdapter>;
export const telephonyAdapter: TelephonyAdapter = createTelephonyAdapter();
