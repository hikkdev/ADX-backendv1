import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AE-B — email made testable through the one door: the routes behind the
 * email card.
 *
 * Pinned: `POST /integrations/email/test { to }` sends one message through
 * `shared/email`'s `sendEmail` and answers a verdict — a missing host, a
 * refused SMTP login, a Resend 4xx and a door that does not answer are all
 * 200 with `ok: false` and a sentence, never a 5xx, and never a password;
 * the call is ADMIN + `settings.edit` and audited `INTEGRATION_TESTED`
 * `{ section: 'email', provider, verdict }`. The email section's `mode`
 * (SMTP | ETHEREAL) is strict, and a change is audited `EMAIL_MODE_CHANGED`;
 * the masked GET answers `mode` and, under ETHEREAL, the inbox login and
 * web URL — never the test account's password.
 */
const { config, audit, nodemailer, redis } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn(), getEffectiveEmailConfig: vi.fn(), getEffectiveResendConfig: vi.fn() },
  audit: { logActivity: vi.fn() },
  nodemailer: { createTransport: vi.fn(), createTestAccount: vi.fn(), getTestMessageUrl: vi.fn() },
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

// The row is the test's input: the two effective getters the door reads are
// derived from the mocked row the way the resolver derives them (the real
// getters would read the module-internal loader, not the mock).
vi.mock('../../../shared/integrations/integration-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations/integration-config')>();
  return { ...actual, ...config };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('nodemailer', () => ({ default: nodemailer, ...nodemailer }));
vi.mock('../../../shared/cache/redis', () => ({ redis }));

import { signAccessToken } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { integrationsRouter } from '../integrations.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/integrations', integrationsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');
const viewer = signAccessToken('adm_2', ['ADMIN'], undefined, { perms: ['settings.view'] });
const publisher = tokenFor(['PUBLISHER'], 'pub_1');

const SMTP_PASSWORD = 'gmail-app-password-WXYZ9';
const RESEND_KEY = 're_live_SECRET_4321';
const ETHEREAL_PASS = 'ethereal-throwaway-PASS';

const row = (email: Record<string, unknown> = {}, resend: Record<string, unknown> = {}) => ({
  email: { host: 'smtp.gmail.com', port: 587, user: 'ops@adx.co', password: SMTP_PASSWORD, from: 'ADX <ops@adx.co>', primary: 'SMTP', mode: 'SMTP', ...email },
  resend: { apiKey: RESEND_KEY, fromEmail: 'ADX <hello@adx.co>', ...resend },
});

let sendMailMock: ReturnType<typeof vi.fn>;

const testCall = (body: object, token = admin) =>
  request(app()).post('/api/v1/integrations/email/test').set('Authorization', `Bearer ${token}`).send(body);

const tested = () => audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_TESTED');

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue(row());
  config.updateIntegrationsConfig.mockResolvedValue({});
  config.getEffectiveEmailConfig.mockImplementation(async () => {
    const cfg = (await config.getIntegrationsConfig()) as ReturnType<typeof row>;
    return { ...cfg.email, primary: cfg.email.primary ?? 'SMTP', mode: cfg.email.mode ?? 'SMTP' };
  });
  config.getEffectiveResendConfig.mockImplementation(async () => {
    const cfg = (await config.getIntegrationsConfig()) as ReturnType<typeof row>;
    return { ...cfg.resend };
  });
  sendMailMock = vi.fn(async () => ({ messageId: '<m1@adx>', response: '250 2.0.0 OK queued' }));
  nodemailer.createTransport.mockReturnValue({ sendMail: sendMailMock });
  nodemailer.createTestAccount.mockResolvedValue({
    user: 'inbox.throwaway@ethereal.email',
    pass: ETHEREAL_PASS,
    smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
  });
  nodemailer.getTestMessageUrl.mockReturnValue('https://ethereal.email/message/xyz');
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('POST /integrations/email/test', () => {
  it('is ADMIN + settings.edit: a publisher and a view-only admin are refused, nothing is sent', async () => {
    expect((await testCall({ to: 'ops@adx.co' }, publisher)).status).toBe(403);
    expect((await testCall({ to: 'ops@adx.co' }, viewer)).status).toBe(403);
    expect((await testCall({ to: 'ops@adx.co' }, publisher)).status).toBe(403);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('refuses a body without an email address, 400, before anything is sent', async () => {
    expect((await testCall({})).status).toBe(400);
    expect((await testCall({ to: 'not-an-address' })).status).toBe(400);
    expect((await testCall({ to: 'ops@adx.co', subject: 'x' })).status).toBe(400);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('SMTP with no host: 200, ok false with the sentence, audited without a secret', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row({ host: undefined }));
    const res = await testCall({ to: 'ops@adx.co' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      provider: 'SMTP',
      configured: false,
      ok: false,
      messageId: null,
      previewUrl: null,
      response: null,
      message: 'SMTP is not configured - fill the host, or switch the mode to Ethereal for a test inbox.',
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    const call = tested();
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ targetType: 'AppConfig', targetId: 'integrations', module: 'integrations' });
    expect(call![2].metadata).toEqual({ section: 'email', provider: 'SMTP', verdict: { configured: false, ok: false, previewUrl: null } });
    expect(res.text).not.toContain(SMTP_PASSWORD);
  });

  it('Ethereal: 200 ok with the preview URL, the inbox created once and cached, the password nowhere', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row({ host: undefined, mode: 'ETHEREAL' }));
    const res = await testCall({ to: 'ops@adx.co' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'ETHEREAL',
      configured: true,
      ok: true,
      messageId: '<m1@adx>',
      previewUrl: 'https://ethereal.email/message/xyz',
      response: '250 2.0.0 OK queued',
    });
    expect(res.body.data.message).toMatch(/Ethereal/);
    expect(nodemailer.createTestAccount).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('email:ethereal:account', expect.any(String), 'EX', 24 * 3600);
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@adx.co', subject: 'ADX test message' }));
    expect(res.text).not.toContain(ETHEREAL_PASS);
    expect(tested()![2].metadata).toEqual({
      section: 'email',
      provider: 'ETHEREAL',
      verdict: { configured: true, ok: true, previewUrl: 'https://ethereal.email/message/xyz' },
    });
    expect(JSON.stringify(tested()![2].metadata)).not.toContain(ETHEREAL_PASS);
  });

  it('an SMTP login refusal is 200 ok:false with the vendor sentence, the password masked', async () => {
    sendMailMock.mockRejectedValue(new Error(`Invalid login: 535-5.7.8 Username and Password not accepted. (${SMTP_PASSWORD})`));
    const res = await testCall({ to: 'ops@adx.co' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'SMTP', configured: true, ok: false, messageId: null, previewUrl: null });
    expect(res.body.data.message).toContain('Username and Password not accepted');
    expect(res.text).not.toContain(SMTP_PASSWORD);
    expect(tested()![2].metadata).toMatchObject({ section: 'email', provider: 'SMTP', verdict: { ok: false } });
    expect(JSON.stringify(tested()![2].metadata)).not.toContain(SMTP_PASSWORD);
  });

  it('a Resend 4xx is 200 ok:false with Resend`s sentence, the key nowhere', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row({ primary: 'RESEND' }));
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ statusCode: 401, name: 'validation_error', message: 'API key is invalid' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await testCall({ to: 'ops@adx.co' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.body.data).toMatchObject({ provider: 'RESEND', configured: true, ok: false });
    expect(res.body.data.message).toContain('401');
    expect(res.body.data.message).toContain('API key is invalid');
    expect(res.text).not.toContain(RESEND_KEY);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('a door that does not answer in 15 s is 200 with the timeout sentence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMailMock.mockImplementation(() => new Promise(() => undefined));
    const pending = testCall({ to: 'ops@adx.co' });
    await vi.advanceTimersByTimeAsync(15_001);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'SMTP', configured: true, ok: false, message: 'The door did not answer in time' });
  });
});

describe('PUT /integrations { section: email } — the mode', () => {
  it('writes a strict mode and audits EMAIL_MODE_CHANGED with the before and after, never the password', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'email', patch: { mode: 'ETHEREAL' } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('email', { mode: 'ETHEREAL' });
    const changed = audit.logActivity.mock.calls.find((call) => call[1] === 'EMAIL_MODE_CHANGED');
    expect(changed).toBeDefined();
    expect(changed![0]).toBe('adm_1');
    expect(changed![2]).toMatchObject({ targetType: 'AppConfig', targetId: 'integrations', module: 'integrations' });
    expect(changed![2].diff).toEqual({ mode: { before: 'SMTP', after: 'ETHEREAL' } });
    expect(JSON.stringify({ diff: changed![2].diff, metadata: changed![2].metadata })).not.toContain(SMTP_PASSWORD);
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'INTEGRATION_CONFIG_UPDATED', expect.anything(), { section: 'email', fields: ['mode'] });
  });

  it('refuses a mode off the pair and a stray key, 400, writing nothing', async () => {
    const bad = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'email', patch: { mode: 'MAILHOG' } });
    expect(bad.status).toBe(400);
    const stray = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'email', patch: { mode: 'ETHEREAL', etherealPassword: 'x' } });
    expect(stray.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('a write that does not touch the mode is not audited as a mode change', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'email', patch: { host: 'smtp.example.com', port: 465 } });
    expect(res.status).toBe(200);
    expect(audit.logActivity.mock.calls.find((call) => call[1] === 'EMAIL_MODE_CHANGED')).toBeUndefined();
  });
});

describe('GET /integrations — the email section', () => {
  it('answers the mode; under SMTP no ethereal block', async () => {
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toMatchObject({ host: 'smtp.gmail.com', port: 587, mode: 'SMTP', primary: 'SMTP', password: `••••${SMTP_PASSWORD.slice(-4)}` });
    expect(res.body.data.email.ethereal).toBeUndefined();
    expect(res.text).not.toContain(SMTP_PASSWORD);
  });

  it('under ETHEREAL answers the inbox login and the web URL — never the test account`s password', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row({ mode: 'ETHEREAL' }));
    redis.get.mockResolvedValue(
      JSON.stringify({ user: 'inbox.throwaway@ethereal.email', pass: ETHEREAL_PASS, smtp: { host: 'smtp.ethereal.email', port: 587, secure: false } }),
    );
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email.mode).toBe('ETHEREAL');
    expect(res.body.data.email.ethereal).toEqual({ user: 'inbox.throwaway@ethereal.email', webUrl: 'https://ethereal.email/login' });
    expect(res.text).not.toContain(ETHEREAL_PASS);
    expect(nodemailer.createTestAccount).not.toHaveBeenCalled();
  });

  it('under ETHEREAL with no inbox yet, the login is null and none is created by a read', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row({ mode: 'ETHEREAL' }));
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.email.ethereal).toEqual({ user: null, webUrl: 'https://ethereal.email/login' });
    expect(nodemailer.createTestAccount).not.toHaveBeenCalled();
  });
});
