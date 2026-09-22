import { createHmac, generateKeyPairSync } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * LH6: the outreach adapters.
 *
 * Every adapter's NOT_CONFIGURED path; each provider's send shape through a
 * fake fetch; each webhook parser on a fixture; the signatures; the TwiML;
 * the outcome mapping. Nothing here touches a database or the network.
 */
vi.mock('../../integrations/integration-config', () => ({
  getEffectiveLeadChannelsConfig: vi.fn(async () => ({})),
  DEFAULT_CONSENT_LINE: 'This call may be recorded for quality',
}));

import { createGoogleBusinessAdapter, describeGoogleBusiness, gbmSignature, serviceAccountJwt } from '../google-business';
import { metaHandshake, metaSignature, verifyMetaWebhook } from '../meta';
import { createMetaDmAdapter, describeMetaDm } from '../meta-dm';
import { answerTwiml, createTelephonyAdapter, describeTelephony, e164, ivrTwiml, outcomeOf, twilioVoiceSignature } from '../telephony';
import { epochToDate, OutreachWebhookRejected } from '../types';
import { createWhatsAppAdapter, describeWhatsApp, orderedValues, waNumber } from '../whatsapp';

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: unknown = { messages: [{ id: 'wamid.1' }] }, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('LH6: WhatsApp adapter', () => {
  it('is NOT_CONFIGURED without a BSP, and names the missing fields per BSP', async () => {
    expect(describeWhatsApp(undefined)).toEqual({ configured: false, provider: null, missing: ['bsp'] });
    expect(describeWhatsApp({ bsp: 'GUPSHUP', apiKey: 'k' })).toEqual({ configured: false, provider: 'gupshup', missing: ['appName', 'sourceNumber'] });
    expect(describeWhatsApp({ bsp: 'INTERAKT' }).missing).toEqual(['apiKey']);
    expect(describeWhatsApp({ bsp: 'META', phoneNumberId: '1', accessToken: 't' }).configured).toBe(true);
    const { fetchImpl } = fakeFetch();
    const adapter = createWhatsAppAdapter({ fetchImpl, config: async () => undefined });
    const outcome = await adapter.sendText({ to: '+919876543210', text: 'hi' });
    expect(outcome).toEqual({ ok: false, code: 'NOT_CONFIGURED', message: expect.stringContaining('bsp') });
    expect(fetchImpl).not.toHaveBeenCalled();
    const template = await adapter.sendTemplate({ to: '+919876543210', template: { name: 'intro' }, values: {} });
    expect(template.ok).toBe(false);
  });

  it('sends free-form text through Gupshup as a form post with the apikey header', async () => {
    const { fetchImpl, calls } = fakeFetch({ messageId: 'gs-1' });
    const adapter = createWhatsAppAdapter({ fetchImpl, config: async () => ({ bsp: 'GUPSHUP', apiKey: 'key', appName: 'ADX', sourceNumber: '+91 80000 00000' }) });
    const outcome = await adapter.sendText({ to: '+91 98765 43210', text: 'Hello from ADX' });
    expect(outcome).toEqual({ ok: true, providerId: 'gs-1', response: expect.any(String) });
    expect(calls[0]!.url).toBe('https://api.gupshup.io/wa/api/v1/msg');
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('destination')).toBe('919876543210');
    expect(body.get('source')).toBe('918000000000');
    expect(JSON.parse(body.get('message')!)).toEqual({ type: 'text', text: 'Hello from ADX' });
    expect((calls[0]!.init.headers as Record<string, string>)['apikey']).toBe('key');
  });

  it('sends a template through Interakt and Meta with the values in the template’s order', async () => {
    const template = { name: 'lead_intro', language: 'en', params: ['contactName', 'agentName'] };
    const values = { agentName: 'Asha', contactName: 'Ravi' };
    expect(orderedValues(template, values)).toEqual(['Ravi', 'Asha']);
    const interakt = fakeFetch({ result: { message_id: 'ik-1' } });
    const outcome = await createWhatsAppAdapter({ fetchImpl: interakt.fetchImpl, config: async () => ({ bsp: 'INTERAKT', apiKey: 'basic' }) }).sendTemplate({ to: '9876543210', template, values });
    expect(outcome).toEqual({ ok: true, providerId: 'ik-1', response: expect.any(String) });
    const sent = JSON.parse(String(interakt.calls[0]!.init.body));
    expect(sent.template).toEqual({ name: 'lead_intro', languageCode: 'en', bodyValues: ['Ravi', 'Asha'] });
    const meta = fakeFetch({ messages: [{ id: 'wamid.9' }] });
    const cloud = await createWhatsAppAdapter({ fetchImpl: meta.fetchImpl, config: async () => ({ bsp: 'META', phoneNumberId: '111', accessToken: 'tok' }) }).sendTemplate({ to: '+919876543210', template, values });
    expect(cloud).toMatchObject({ ok: true, providerId: 'wamid.9' });
    expect(meta.calls[0]!.url).toBe('https://graph.facebook.com/v21.0/111/messages');
    const cloudBody = JSON.parse(String(meta.calls[0]!.init.body));
    expect(cloudBody.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Ravi', 'Asha']);
  });

  it('answers PROVIDER_ERROR on a refused post rather than throwing', async () => {
    const { fetchImpl } = fakeFetch({ error: 'bad' }, 401);
    const outcome = await createWhatsAppAdapter({ fetchImpl, config: async () => ({ bsp: 'INTERAKT', apiKey: 'k' }) }).sendText({ to: '9876543210', text: 'x' });
    expect(outcome).toEqual({ ok: false, code: 'PROVIDER_ERROR', message: 'text: HTTP 401' });
  });

  it('reads the Gupshup, Interakt and Meta webhooks into messages and statuses', async () => {
    const adapter = createWhatsAppAdapter({ config: async () => ({ bsp: 'META', phoneNumberId: '1', accessToken: 't', appSecret: 'secret' }) });
    const gupshup = await adapter.parseWebhook({ headers: {}, body: { app: 'ADX', timestamp: 1758540000000, type: 'message', payload: { id: 'gs-in-1', source: '919876543210', type: 'text', payload: { text: 'Yes, interested' }, sender: { phone: '919876543210', name: 'Ravi' } } } });
    expect(gupshup).toEqual([{ kind: 'MESSAGE', channel: 'WHATSAPP', providerThreadId: 'wa:919876543210', providerMessageId: 'gs-in-1', from: '919876543210', fromName: 'Ravi', text: 'Yes, interested', at: new Date(1758540000000), source: 'DM' }]);
    const gupshupStatus = await adapter.parseWebhook({ headers: {}, body: { type: 'message-event', timestamp: 1758540000, payload: { id: 'gs-1', gsId: 'gs-1', type: 'delivered' } } });
    expect(gupshupStatus).toEqual([{ kind: 'STATUS', channel: 'WHATSAPP', providerMessageId: 'gs-1', status: 'DELIVERED', error: null, at: new Date(1758540000000) }]);
    const interakt = await adapter.parseWebhook({ headers: {}, body: { type: 'message_received', data: { customer: { country_code: '+91', phone_number: '9876543210', traits: { name: 'Ravi' } }, message: { id: 'ik-in-1', message: 'Call me at 5', received_at_utc: '2026-09-22T10:00:00Z' } } } });
    expect(interakt[0]).toMatchObject({ kind: 'MESSAGE', providerThreadId: 'wa:919876543210', providerMessageId: 'ik-in-1', text: 'Call me at 5', fromName: 'Ravi' });
    const interaktFailed = await adapter.parseWebhook({ headers: {}, body: { type: 'message_api_failed', data: { message: { id: 'ik-1', message_status_reason: 'Number not on WhatsApp' } } } });
    expect(interaktFailed[0]).toMatchObject({ kind: 'STATUS', status: 'FAILED', error: 'Number not on WhatsApp' });
    // Meta signs its envelope; the wrong signature is refused, the right one read.
    const envelope = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '919876543210', profile: { name: 'Ravi' } }], messages: [{ from: '919876543210', id: 'wamid.in', timestamp: '1758540000', type: 'text', text: { body: 'Hi' } }], statuses: [{ id: 'wamid.out', status: 'read', timestamp: '1758540001' }] } }] }] };
    const raw = Buffer.from(JSON.stringify(envelope));
    await expect(adapter.parseWebhook({ headers: { 'x-hub-signature-256': 'sha256=nope' }, rawBody: raw, body: envelope })).rejects.toBeInstanceOf(OutreachWebhookRejected);
    const events = await adapter.parseWebhook({ headers: { 'x-hub-signature-256': metaSignature('secret', raw) }, rawBody: raw, body: envelope });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'MESSAGE', providerThreadId: 'wa:919876543210', fromName: 'Ravi', text: 'Hi' });
    expect(events[1]).toMatchObject({ kind: 'STATUS', providerMessageId: 'wamid.out', status: 'READ' });
    expect(waNumber('+91 98765-43210')).toBe('919876543210');
  });
});

describe('LH6: Meta DM adapter (Instagram, Messenger)', () => {
  it('is NOT_CONFIGURED per card and sends a RESPONSE to a scoped id when configured', async () => {
    expect(describeMetaDm(undefined, 'INSTAGRAM')).toEqual({ configured: false, provider: 'meta-instagram', missing: ['pageId', 'accessToken'] });
    const { fetchImpl, calls } = fakeFetch({ message_id: 'm_1', recipient_id: 'psid' });
    const adapter = createMetaDmAdapter({ fetchImpl, config: async () => ({ messenger: { pageId: 'p', accessToken: 'tok' } }) });
    expect(await adapter.sendText('INSTAGRAM', { to: 'igsid', text: 'hi' })).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await adapter.sendText('MESSENGER', { to: 'psid', text: 'Thanks for writing' })).toEqual({ ok: true, providerId: 'm_1', response: expect.any(String) });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/me/messages?access_token=tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ recipient: { id: 'psid' }, message: { text: 'Thanks for writing' }, messaging_type: 'RESPONSE' });
  });

  it('reads DMs, story replies, comments and deliveries, skipping echoes of our own sends', async () => {
    const adapter = createMetaDmAdapter({ config: async () => ({ instagram: { pageId: 'ig-page', accessToken: 't', appSecret: 'ig-secret', verifyToken: 'verify-me' } }) });
    const envelope = {
      object: 'instagram',
      entry: [
        {
          time: 1758540000000,
          messaging: [
            { sender: { id: 'user-1' }, recipient: { id: 'ig-page' }, timestamp: 1758540000000, message: { mid: 'mid-1', text: 'Is the wall free?' } },
            { sender: { id: 'user-2' }, recipient: { id: 'ig-page' }, timestamp: 1758540001000, message: { mid: 'mid-2', text: 'love it', reply_to: { story: { id: 's1', url: 'x' } } } },
            { sender: { id: 'ig-page' }, recipient: { id: 'user-1' }, timestamp: 1758540002000, message: { mid: 'mid-echo', is_echo: true, text: 'our reply' } },
            { sender: { id: 'user-1' }, recipient: { id: 'ig-page' }, timestamp: 1758540003000, delivery: { mids: ['mid-out'], watermark: 1758540003000 } },
          ],
          changes: [{ field: 'comments', value: { id: 'c-9', text: 'DM me the rates', from: { id: 'user-3', username: 'ravi.k' }, created_time: 1758540004 } }],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(envelope));
    const events = await adapter.parseWebhook({ headers: { 'x-hub-signature-256': metaSignature('ig-secret', raw) }, rawBody: raw, body: envelope });
    expect(events.map((e) => (e.kind === 'MESSAGE' ? `${e.source}:${e.providerThreadId}` : `${e.status}:${e.providerMessageId}`))).toEqual(['DM:user-1', 'STORY_REPLY:user-2', 'DELIVERED:mid-out', 'COMMENT:user-3']);
    expect(events[3]).toMatchObject({ providerMessageId: 'comment:c-9', fromName: 'ravi.k', text: 'DM me the rates' });
    expect(metaHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '123' }, ['verify-me'])).toBe('123');
    expect(metaHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '123' }, ['verify-me'])).toBeNull();
    expect(() => verifyMetaWebhook({ headers: {}, rawBody: raw, body: envelope }, [undefined])).toThrow(OutreachWebhookRejected);
  });
});

describe('LH6: Google Business Messages adapter', () => {
  it('is NOT_CONFIGURED without the agent, the service account and the partner key', async () => {
    expect(describeGoogleBusiness({ agentId: 'a' }).missing).toEqual(['serviceAccountJson', 'partnerKey']);
    const adapter = createGoogleBusinessAdapter({ config: async () => ({ agentId: 'a' }) });
    expect(await adapter.sendText({ to: 'conv', text: 'x' })).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(adapter.handshake({ clientToken: 'c', secret: 's' })).toEqual({ secret: 's' });
    expect(adapter.handshake({ conversationId: 'x' })).toBeNull();
  });

  it('signs a service-account JWT, exchanges it and posts the message; verifies the partner-key signature on the way in', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccountJson = JSON.stringify({ client_email: 'adx@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const jwt = serviceAccountJwt(serviceAccountJson, new Date('2026-09-22T10:00:00Z'));
    expect(jwt.split('.')).toHaveLength(3);
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'bearer-1', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ name: 'conversations/conv-1/messages/m-1', messageId: 'm-1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createGoogleBusinessAdapter({ fetchImpl, config: async () => ({ agentId: 'brands/x/agents/y', serviceAccountJson, partnerKey: 'partner' }) });
    const outcome = await adapter.sendText({ to: 'conv-1', text: 'Hello' });
    expect(outcome).toEqual({ ok: true, providerId: 'm-1', response: 'conversations/conv-1/messages/m-1' });
    expect(calls[1]!.url).toBe('https://businessmessages.googleapis.com/v1/conversations/conv-1/messages');
    expect((calls[1]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer bearer-1');
    const body = { conversationId: 'conv-1', message: { messageId: 'in-1', text: 'Do you do hoardings?', createTime: '2026-09-22T10:00:00Z' }, context: { userInfo: { displayName: 'Ravi' } } };
    const raw = Buffer.from(JSON.stringify(body));
    const events = await adapter.parseWebhook({ headers: { 'x-goog-signature': gbmSignature('partner', raw) }, rawBody: raw, body });
    expect(events).toEqual([{ kind: 'MESSAGE', channel: 'GOOGLE_BUSINESS', providerThreadId: 'conv-1', providerMessageId: 'in-1', from: 'conv-1', fromName: 'Ravi', text: 'Do you do hoardings?', at: new Date('2026-09-22T10:00:00Z'), source: 'DM' }]);
    await expect(adapter.parseWebhook({ headers: { 'x-goog-signature': 'bad' }, rawBody: raw, body })).rejects.toBeInstanceOf(OutreachWebhookRejected);
    expect(gbmSignature('partner', raw)).toBe(createHmac('sha512', 'partner').update(raw).digest('base64'));
  });
});

describe('LH6: telephony adapter', () => {
  it('is NOT_CONFIGURED per provider and refuses a call without a masked number', async () => {
    expect(describeTelephony(undefined)).toEqual({ configured: false, provider: null, missing: ['provider'] });
    expect(describeTelephony({ provider: 'EXOTEL', accountSid: 'sid' }).missing).toEqual(['apiKey', 'apiToken', 'subdomain']);
    expect(describeTelephony({ provider: 'TWILIO', accountSid: 'AC', apiToken: 't' }).configured).toBe(true);
    const base = { agentNumber: '9000000001', leadNumber: '9876543210', record: false, consentLine: null, statusCallbackUrl: 'https://adx/status', answerUrl: 'https://adx/answer' };
    const unconfigured = createTelephonyAdapter({ config: async () => undefined });
    expect(await unconfigured.placeCall({ ...base, callerId: '+918000000000' })).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    const noCaller = createTelephonyAdapter({ config: async () => ({ provider: 'TWILIO', accountSid: 'AC', apiToken: 't' }) });
    expect(await noCaller.placeCall({ ...base, callerId: '' })).toEqual({ ok: false, code: 'NO_CALLER_ID', message: expect.any(String) });
  });

  it('places a call on each operator — agent first, lead on the masked number, recording only when asked', async () => {
    const base = { agentNumber: '9000000001', leadNumber: '98765 43210', callerId: '+918000000000', record: true, consentLine: 'This call may be recorded', statusCallbackUrl: 'https://adx/status', answerUrl: 'https://adx/answer' };
    const exotel = fakeFetch({ Call: { Sid: 'ex-1' } });
    const ex = await createTelephonyAdapter({ fetchImpl: exotel.fetchImpl, config: async () => ({ provider: 'EXOTEL', accountSid: 'adx', apiKey: 'k', apiToken: 't', subdomain: 'api.exotel.com' }) }).placeCall(base);
    expect(ex).toEqual({ ok: true, providerCallId: 'ex-1', maskedNumber: '+918000000000' });
    expect(exotel.calls[0]!.url).toBe('https://api.exotel.com/v1/Accounts/adx/Calls/connect.json');
    const exForm = new URLSearchParams(String(exotel.calls[0]!.init.body));
    expect(exForm.get('From')).toBe('+919000000001');
    expect(exForm.get('To')).toBe('+919876543210');
    expect(exForm.get('CallerId')).toBe('+918000000000');
    expect(exForm.get('Record')).toBe('true');
    const knowlarity = fakeFetch({ success: { call_id: 'kn-1' } });
    const kn = await createTelephonyAdapter({ fetchImpl: knowlarity.fetchImpl, config: async () => ({ provider: 'KNOWLARITY', apiKey: 'k', apiToken: 't', subdomain: '+918030000000' }) }).placeCall({ ...base, record: false });
    expect(kn).toMatchObject({ ok: true, providerCallId: 'kn-1' });
    expect(JSON.parse(String(knowlarity.calls[0]!.init.body))).toEqual({ k_number: '+918030000000', agent_number: '+919000000001', customer_number: '+919876543210', caller_id: '+918000000000' });
    const twilio = fakeFetch({ sid: 'CA1' });
    const tw = await createTelephonyAdapter({ fetchImpl: twilio.fetchImpl, config: async () => ({ provider: 'TWILIO', accountSid: 'AC', apiToken: 't' }) }).placeCall(base);
    expect(tw).toMatchObject({ ok: true, providerCallId: 'CA1' });
    const twForm = new URLSearchParams(String(twilio.calls[0]!.init.body));
    expect(twForm.get('To')).toBe('+919000000001');
    expect(twForm.get('From')).toBe('+918000000000');
    expect(twForm.get('Url')).toBe('https://adx/answer');
  });

  it('builds the TwiML: the consent line only gates a recorded call; the IVR gathers one digit', () => {
    const recorded = answerTwiml({ consentLine: 'This call may be recorded for quality', leadNumber: '9876543210', callerId: '+918000000000', record: true, statusCallbackUrl: 'https://adx/status' });
    expect(recorded).toContain('<Say>This call may be recorded for quality</Say>');
    expect(recorded).toContain('record="record-from-answer-dual"');
    expect(recorded).toContain('<Number>+919876543210</Number>');
    const plain = answerTwiml({ consentLine: 'This call may be recorded for quality', leadNumber: '9876543210', callerId: '+918000000000', record: false, statusCallbackUrl: 'https://adx/status' });
    expect(plain).not.toContain('<Say>');
    expect(plain).not.toContain('record=');
    const ivr = ivrTwiml({ greeting: 'Welcome to ADX.', publisherPrompt: 'Press 1 to earn from your wall.', advertiserPrompt: 'Press 2 to advertise.', actionUrl: 'https://adx/ivr/choice?token=a&b=c' });
    expect(ivr).toContain('<Gather numDigits="1" action="https://adx/ivr/choice?token=a&amp;b=c" method="POST">');
    expect(ivr).toContain('Press 2 to advertise.');
  });

  it('maps every operator’s status word onto the four outcomes', () => {
    expect(outcomeOf('completed', 42)).toBe('ANSWERED');
    expect(outcomeOf('completed', 0)).toBe('NO_ANSWER');
    expect(outcomeOf('busy', null)).toBe('BUSY');
    expect(outcomeOf('no-answer', null)).toBe('NO_ANSWER');
    expect(outcomeOf('NOANSWER', null)).toBe('NO_ANSWER');
    expect(outcomeOf('completed', 20, 'machine_end_beep')).toBe('VOICEMAIL');
    expect(outcomeOf('in-progress', null)).toBeNull();
    expect(e164('98765 43210')).toBe('+919876543210');
    expect(e164('09876543210')).toBe('+919876543210');
    expect(e164('+14155550100')).toBe('+14155550100');
  });

  it('reads the status and inbound hooks — Twilio on its signature, the others on the URL token', async () => {
    const twilio = createTelephonyAdapter({ config: async () => ({ provider: 'TWILIO', accountSid: 'AC', apiToken: 'tok' }) });
    const url = 'https://adx.in/api/v1/webhooks/outreach/telephony/status';
    const params = { CallSid: 'CA1', DialCallStatus: 'completed', DialCallDuration: '61', RecordingUrl: 'https://api.twilio.com/rec/RE1' };
    await expect(twilio.parseStatus({ headers: { 'x-twilio-signature': 'bad' }, body: params, url })).rejects.toBeInstanceOf(OutreachWebhookRejected);
    const status = await twilio.parseStatus({ headers: { 'x-twilio-signature': twilioVoiceSignature('tok', url, params) }, body: params, url });
    expect(status).toMatchObject({ providerCallId: 'CA1', outcome: 'ANSWERED', durationSec: 61, recordingUrl: 'https://api.twilio.com/rec/RE1', final: true });
    const exotel = createTelephonyAdapter({ config: async () => ({ provider: 'EXOTEL', accountSid: 'a', apiKey: 'k', apiToken: 't', subdomain: 's', webhookSecret: 'hook' }) });
    await expect(exotel.parseStatus({ headers: {}, body: { CallSid: 'ex-1', Status: 'completed' }, query: {} })).rejects.toBeInstanceOf(OutreachWebhookRejected);
    const exStatus = await exotel.parseStatus({ headers: {}, body: { CallSid: 'ex-1', Status: 'no-answer', ConversationDuration: '0' }, query: { token: 'hook' } });
    expect(exStatus).toMatchObject({ providerCallId: 'ex-1', outcome: 'NO_ANSWER', durationSec: 0, final: true });
    const missed = await exotel.parseInbound({ headers: {}, body: { CallFrom: '09876543210', CallTo: '08030000000', CallSid: 'ex-in' }, query: { token: 'hook' } });
    expect(missed).toMatchObject({ from: '+919876543210', to: '+918030000000', providerCallId: 'ex-in', digits: null });
    const ivr = await exotel.parseInbound({ headers: {}, body: { CallFrom: '9876543210', digits: '"2"' }, query: { token: 'hook' } });
    expect(ivr?.digits).toBe('2');
    const knowlarity = createTelephonyAdapter({ config: async () => ({ provider: 'KNOWLARITY', apiKey: 'k', apiToken: 't', subdomain: 'sr', webhookSecret: 'hook' }) });
    const kn = await knowlarity.parseStatus({ headers: { 'x-webhook-token': 'hook' }, body: { uuid: 'kn-1', call_status: 'ANSWER', call_duration: 30, resource_url: 'https://k/rec.mp3' } });
    expect(kn).toMatchObject({ providerCallId: 'kn-1', outcome: 'ANSWERED', durationSec: 30, recordingUrl: 'https://k/rec.mp3' });
  });
});

describe('LH6: the shared readers', () => {
  it('reads seconds, milliseconds, ISO strings and rubbish into a date', () => {
    expect(epochToDate(1758540000)).toEqual(new Date(1758540000000));
    expect(epochToDate('1758540000000')).toEqual(new Date(1758540000000));
    expect(epochToDate('2026-09-22T10:00:00Z')).toEqual(new Date('2026-09-22T10:00:00Z'));
    const now = new Date('2026-01-01T00:00:00Z');
    expect(epochToDate('soon', now)).toBe(now);
  });
});
