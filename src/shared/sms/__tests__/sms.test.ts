import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SMS rails — Lot E (Q128).
 *
 * What is pinned: a send names a kind and the rail renders it from its own
 * registration (MSG91 gets the flow id and named variables, Twilio the
 * registered text with the DLT ids); a kind registered nowhere is skipped,
 * not sent; the primary rail failing hands the message to the next; and a
 * Twilio report with a bad signature is refused rather than recorded.
 */

const { config, env } = vi.hoisted(() => ({
  config: {
    getEffectiveSmsConfig: vi.fn(),
    getEffectiveTwilioConfig: vi.fn(),
  },
  env: { env: { NODE_ENV: 'production', SMS_LIVE_IN_DEV: false } },
}));

vi.mock('../../integrations/integration-config', () => config);
vi.mock('../../../config/env', () => env);

import { createMsg91Rail } from '../rails/msg91';
import { createTwilioRail, twilioSignature } from '../rails/twilio';
import { thirdRail } from '../rails/third';
import { renderSmsBody, toE164, WebhookRejected } from '../rail';
import { isSmsKindRegistered, sendSms } from '../sms';

const smsConfig = (over: Record<string, unknown> = {}) => ({
  authKey: 'msg91-key',
  primaryRail: 'msg91',
  fallbackRails: ['twilio'],
  dltEntityId: '1101',
  senderId: 'ADXADS',
  templates: {
    msg91: { LOGIN_OTP: { templateId: 'flow-otp', vars: ['code', 'minutes'] } },
    twilio: { LOGIN_OTP: { templateId: 'dlt-otp', body: 'Your ADX OTP is {{code}}. Valid {{minutes}} min.' } },
  },
  ...over,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const down = () => ({ ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  env.env.NODE_ENV = 'production';
  env.env.SMS_LIVE_IN_DEV = false;
  config.getEffectiveSmsConfig.mockResolvedValue(smsConfig());
  config.getEffectiveTwilioConfig.mockResolvedValue({ accountSid: 'AC1', authToken: 'tok', phoneNumber: '+15550001' });
});

describe('number and body helpers', () => {
  it('canonicalises an Indian number to E.164', () => {
    expect(toE164('9845012210')).toBe('+919845012210');
    expect(toE164('09845012210')).toBe('+919845012210');
    expect(toE164('919845012210')).toBe('+919845012210');
    expect(toE164('+91 98450 12210')).toBe('+919845012210');
  });

  it('renders {{name}} placeholders and blanks the ones it does not know', () => {
    expect(renderSmsBody('OTP {{code}} for {{ minutes }} min {{nope}}', { code: '123456', minutes: '10' })).toBe('OTP 123456 for 10 min ');
  });
});

describe('MSG91', () => {
  it('posts the flow id and the named variables, never the whole text', async () => {
    const fetchImpl = vi.fn(async () => ok({ type: 'success', message: 'req-1' }));
    const rail = createMsg91Rail({ fetchImpl: fetchImpl as never });
    const result = await rail.send({
      to: '+919845012210',
      kind: 'LOGIN_OTP',
      registration: { templateId: 'flow-otp', vars: ['code', 'minutes'] },
      vars: { code: '123456', minutes: '10', extra: 'no' },
      body: 'rendered',
      dlt: { entityId: '1101', senderId: 'ADXADS' },
    });
    // Lot G (Q121): the rail's answer rides beside the id, for the delivery log's attempt row.
    expect(result).toEqual({ providerMessageId: 'req-1', responseText: '{"type":"success","message":"req-1"}' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect((init.headers as Record<string, string>)['authkey']).toBe('msg91-key');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      template_id: 'flow-otp',
      short_url: '0',
      sender: 'ADXADS',
      recipients: [{ mobiles: '919845012210', code: '123456', minutes: '10' }],
    });
    expect(JSON.stringify(body)).not.toContain('rendered');
  });

  it('reads a delivery report array into per-request statuses', async () => {
    const rail = createMsg91Rail();
    const reports = await rail.parseDeliveryWebhook({
      url: 'https://api.adx.local/api/v1/webhooks/msg91',
      headers: {},
      body: [
        { requestId: 'req-1', report: [{ number: '919845012210', status: '1', desc: 'DELIVERED', date: '2026-09-12 10:00:00' }] },
        { requestId: 'req-2', report: [{ number: '919845012211', status: '16', desc: 'REJECTED' }] },
        { requestId: 'req-3', status: 5 },
      ],
    });
    expect(reports).toMatchObject([
      { providerMessageId: 'req-1', status: 'DELIVERED' },
      { providerMessageId: 'req-2', status: 'FAILED', error: 'REJECTED' },
      { providerMessageId: 'req-3', status: 'SENT' },
    ]);
  });
});

describe('Twilio', () => {
  it('posts the registered text with the DLT entity and template ids, from the DLT header', async () => {
    const fetchImpl = vi.fn(async () => ok({ sid: 'SM1', status: 'queued' }));
    const rail = createTwilioRail({ fetchImpl: fetchImpl as never });
    const result = await rail.send({
      to: '9845012210',
      kind: 'LOGIN_OTP',
      registration: { templateId: 'dlt-otp' },
      vars: { code: '123456' },
      body: 'Your ADX OTP is 123456.',
      dlt: { entityId: '1101', senderId: 'ADXADS' },
    });
    // Lot G (Q121): only the sid and the status — Twilio's full body repeats the message text.
    expect(result).toEqual({ providerMessageId: 'SM1', responseText: '{"sid":"SM1","status":"queued"}' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('To')).toBe('+919845012210');
    expect(form.get('From')).toBe('ADXADS');
    expect(form.get('Body')).toBe('Your ADX OTP is 123456.');
    expect(form.get('DltEntityId')).toBe('1101');
    expect(form.get('DltTemplateId')).toBe('dlt-otp');
    expect((init.headers as Record<string, string>)['Authorization']).toMatch(/^Basic /);
  });

  it('accepts a correctly signed status callback and refuses a forged one', async () => {
    const rail = createTwilioRail();
    const url = 'https://api.adx.local/api/v1/webhooks/twilio';
    const body = { MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' };
    const good = await rail.parseDeliveryWebhook({ url, headers: { 'x-twilio-signature': twilioSignature('tok', url, body) }, body });
    expect(good).toEqual([{ providerMessageId: 'SM1', status: 'FAILED', error: 'Twilio error 30003' }]);

    await expect(rail.parseDeliveryWebhook({ url, headers: { 'x-twilio-signature': 'nope' }, body })).rejects.toBeInstanceOf(WebhookRejected);

    config.getEffectiveTwilioConfig.mockResolvedValue({});
    await expect(rail.parseDeliveryWebhook({ url, headers: {}, body })).rejects.toBeInstanceOf(WebhookRejected);
  });
});

describe('the third rail', () => {
  it('answers not configured and carries nothing', async () => {
    await expect(thirdRail.describe()).resolves.toEqual({ configured: false });
    await expect(thirdRail.parseDeliveryWebhook({ url: '', headers: {}, body: {} })).resolves.toEqual([]);
  });
});

describe('sendSms', () => {
  it('logs and skips outside production', async () => {
    env.env.NODE_ENV = 'development';
    await expect(sendSms({ to: '9845012210', kind: 'LOGIN_OTP', vars: { code: '1' } })).resolves.toEqual({ skipped: true, reason: 'DEV' });
  });

  it('skips a kind no rail has registered, and says so', async () => {
    await expect(sendSms({ to: '9845012210', kind: 'VISIT_OFFER', vars: {} })).resolves.toEqual({ skipped: true, reason: 'UNREGISTERED_KIND' });
    await expect(isSmsKindRegistered('VISIT_OFFER')).resolves.toBe(false);
    await expect(isSmsKindRegistered('LOGIN_OTP')).resolves.toBe(true);
  });

  it('falls back to the next rail when the primary throws, rendering the body from the registration', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.includes('msg91') ? down() : ok({ sid: 'SM9' })));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const result = await sendSms({ to: '9845012210', kind: 'LOGIN_OTP', vars: { code: '654321', minutes: 10 } });
      expect(result).toEqual({ skipped: false, rail: 'twilio', providerMessageId: 'SM9', responseText: '{"sid":"SM9","status":null}' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
      expect(new URLSearchParams(String(init.body)).get('Body')).toBe('Your ADX OTP is 654321. Valid 10 min.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports NO_RAIL when every rail carrying the kind is unconfigured', async () => {
    config.getEffectiveSmsConfig.mockResolvedValue(smsConfig({ authKey: undefined, fallbackRails: [] }));
    await expect(sendSms({ to: '9845012210', kind: 'LOGIN_OTP', vars: {} })).resolves.toEqual({ skipped: true, reason: 'NO_RAIL' });
  });

  it('throws the last error when every configured rail fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => down()));
    try {
      await expect(sendSms({ to: '9845012210', kind: 'LOGIN_OTP', vars: {} })).rejects.toThrow(/502/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
