import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AE-B — email made testable through the one door.
 *
 * Pinned: `sendEmail` picks the door by `getEffectiveEmailConfig().primary`
 * (SMTP or Resend) and, on the SMTP door, by `mode` (a real host or an
 * Ethereal test inbox); the Ethereal account is created ONCE and cached in
 * Redis for a day, so a second send creates none and the inbox stays the
 * same; every Ethereal send answers a preview URL; `testEmailDoor` turns
 * what the door did into a verdict — never a throw for anything the vendor
 * did, never a password in it, and a door that does not answer in 15 s
 * says so.
 */
const { nodemailer, redis, config } = vi.hoisted(() => ({
  nodemailer: { createTransport: vi.fn(), createTestAccount: vi.fn(), getTestMessageUrl: vi.fn() },
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  config: { getEffectiveEmailConfig: vi.fn(), getEffectiveResendConfig: vi.fn() },
}));

vi.mock('nodemailer', () => ({ default: nodemailer, ...nodemailer }));
vi.mock('../../cache/redis', () => ({ redis }));
vi.mock('../../integrations/integration-config', () => config);

import { ETHEREAL_ACCOUNT_KEY, ETHEREAL_ACCOUNT_TTL_SECONDS, EMAIL_TEST_TIMEOUT_MS, resolveEmailProvider, sendEmail, testEmailDoor } from '..';

const SMTP_PASSWORD = 'smtp-secret-PASSW0RD';
const RESEND_KEY = 're_live_KEY_9876';

const smtp = (over: Record<string, unknown> = {}) => ({
  host: 'smtp.gmail.com',
  port: 587,
  user: 'ops@adx.co',
  password: SMTP_PASSWORD,
  from: 'ADX <ops@adx.co>',
  primary: 'SMTP',
  mode: 'SMTP',
  ...over,
});

const testAccount = {
  user: 'throwaway.inbox@ethereal.email',
  pass: 'ethereal-PASS-1234',
  smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
  imap: { host: 'imap.ethereal.email', port: 993, secure: true },
  pop3: { host: 'pop3.ethereal.email', port: 995, secure: true },
  web: 'https://ethereal.email',
};

let sendMailMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  sendMailMock = vi.fn(async () => ({ messageId: '<m1@adx>', response: '250 2.0.0 OK queued' }));
  nodemailer.createTransport.mockReturnValue({ sendMail: sendMailMock });
  nodemailer.createTestAccount.mockResolvedValue(testAccount);
  nodemailer.getTestMessageUrl.mockReturnValue('https://ethereal.email/message/abc123');
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
  config.getEffectiveEmailConfig.mockResolvedValue(smtp());
  config.getEffectiveResendConfig.mockResolvedValue({ apiKey: RESEND_KEY, fromEmail: 'ADX <hello@adx.co>' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resolveEmailProvider', () => {
  it('is Resend when the primary says so, else the SMTP door in its mode', () => {
    expect(resolveEmailProvider({ primary: 'RESEND', mode: 'ETHEREAL' })).toBe('RESEND');
    expect(resolveEmailProvider({ primary: 'SMTP', mode: 'ETHEREAL' })).toBe('ETHEREAL');
    expect(resolveEmailProvider({ primary: 'SMTP', mode: 'SMTP' })).toBe('SMTP');
    expect(resolveEmailProvider({})).toBe('SMTP');
  });
});

describe('sendEmail — the one door', () => {
  it('SMTP: a transport on the host, secure by the port, the password never in the answer', async () => {
    const result = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: 'ops@adx.co', pass: SMTP_PASSWORD },
    });
    expect(sendMailMock).toHaveBeenCalledWith({ from: 'ADX <ops@adx.co>', to: 'asha@adx.co', subject: 'Hi', html: '<p>hi</p>' });
    expect(result).toEqual({ provider: 'SMTP', configured: true, messageId: '<m1@adx>', response: '250 2.0.0 OK queued', previewUrl: null });
    expect(nodemailer.createTestAccount).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SMTP_PASSWORD);
  });

  it('SMTP on 465 is implicit TLS', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ port: 465 }));
    await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true }));
  });

  it('SMTP with no host: logged, configured false, nothing sent', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ host: undefined }));
    const result = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(result).toEqual({ provider: 'SMTP', configured: false, messageId: null, response: null, previewUrl: null });
  });

  it('RESEND: the API is asked, SMTP is not, and the mode is not consulted', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ primary: 'RESEND', mode: 'ETHEREAL' }));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"id":"re_1"}' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${RESEND_KEY}`);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(nodemailer.createTestAccount).not.toHaveBeenCalled();
    expect(result).toEqual({ provider: 'RESEND', configured: true, messageId: 're_1', response: '{"id":"re_1"}', previewUrl: null });
  });

  it('RESEND with no key: configured false, nothing asked', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ primary: 'RESEND' }));
    config.getEffectiveResendConfig.mockResolvedValue({ apiKey: undefined, fromEmail: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: 'RESEND', configured: false, messageId: null });
  });

  it('ETHEREAL: a test account is created once, cached in Redis for a day, and the preview URL answered', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ host: undefined, mode: 'ETHEREAL' }));
    const first = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(nodemailer.createTestAccount).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      ETHEREAL_ACCOUNT_KEY,
      JSON.stringify({ user: testAccount.user, pass: testAccount.pass, smtp: testAccount.smtp }),
      'EX',
      ETHEREAL_ACCOUNT_TTL_SECONDS,
    );
    expect(ETHEREAL_ACCOUNT_TTL_SECONDS).toBe(24 * 3600);
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    expect(first).toEqual({
      provider: 'ETHEREAL',
      configured: true,
      messageId: '<m1@adx>',
      response: '250 2.0.0 OK queued',
      previewUrl: 'https://ethereal.email/message/abc123',
    });

    // The second send finds the account in Redis and creates none.
    redis.get.mockResolvedValue(JSON.stringify({ user: testAccount.user, pass: testAccount.pass, smtp: testAccount.smtp }));
    const second = await sendEmail('asha@adx.co', 'Again', '<p>again</p>');
    expect(nodemailer.createTestAccount).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { user: testAccount.user, pass: testAccount.pass } }));
    expect(second.previewUrl).toBe('https://ethereal.email/message/abc123');
  });

  it('ETHEREAL: a Redis miss (or a Redis that is down) just creates a new account', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ mode: 'ETHEREAL' }));
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(nodemailer.createTestAccount).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'ETHEREAL', configured: true, previewUrl: 'https://ethereal.email/message/abc123' });
  });

  it('ETHEREAL: no preview from nodemailer is a null, not a false', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ mode: 'ETHEREAL' }));
    nodemailer.getTestMessageUrl.mockReturnValue(false);
    const result = await sendEmail('asha@adx.co', 'Hi', '<p>hi</p>');
    expect(result.previewUrl).toBeNull();
  });
});

describe('testEmailDoor — the verdict', () => {
  it('SMTP with no host: ok false with the sentence, nothing sent, not audited here', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ host: undefined }));
    const verdict = await testEmailDoor('ops@adx.co');
    expect(verdict).toEqual({
      provider: 'SMTP',
      configured: false,
      ok: false,
      messageId: null,
      previewUrl: null,
      response: null,
      message: 'SMTP is not configured - fill the host, or switch the mode to Ethereal for a test inbox.',
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('RESEND with no key: ok false with a sentence, nothing asked', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ primary: 'RESEND' }));
    config.getEffectiveResendConfig.mockResolvedValue({ apiKey: undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const verdict = await testEmailDoor('ops@adx.co');
    expect(verdict).toMatchObject({ provider: 'RESEND', configured: false, ok: false });
    expect(verdict.message).toMatch(/Resend is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Ethereal: ok with the preview URL, the test message naming the door, the from address and the time', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ mode: 'ETHEREAL' }));
    const now = new Date('2026-09-16T10:30:00.000Z');
    const verdict = await testEmailDoor('ops@adx.co', now);
    expect(verdict).toMatchObject({ provider: 'ETHEREAL', configured: true, ok: true, messageId: '<m1@adx>', previewUrl: 'https://ethereal.email/message/abc123' });
    expect(verdict.message).toMatch(/Ethereal/);
    expect(verdict.message).toMatch(/preview/i);
    const sent = sendMailMock.mock.calls[0]![0] as { to: string; subject: string; html: string };
    expect(sent.to).toBe('ops@adx.co');
    expect(sent.subject).toBe('ADX test message');
    expect(sent.html).toContain('ADX test email');
    expect(sent.html).toContain('Ethereal');
    expect(sent.html).toContain('ADX &lt;ops@adx.co&gt;');
    expect(sent.html).toContain('2026-09-16T10:30:00.000Z');
    expect(sent.html).not.toContain(SMTP_PASSWORD);
  });

  it('SMTP ok: the host and the from address in the sentence', async () => {
    const verdict = await testEmailDoor('ops@adx.co');
    expect(verdict).toMatchObject({ provider: 'SMTP', configured: true, ok: true, messageId: '<m1@adx>', previewUrl: null, response: '250 2.0.0 OK queued' });
    expect(verdict.message).toContain('smtp.gmail.com');
    expect(verdict.message).toContain('ADX <ops@adx.co>');
  });

  it('an SMTP refusal is a verdict: ok false with the vendor sentence, the password masked out of it', async () => {
    sendMailMock.mockRejectedValue(new Error(`Invalid login: 535-5.7.8 Username and Password not accepted (${SMTP_PASSWORD})`));
    const verdict = await testEmailDoor('ops@adx.co');
    expect(verdict).toMatchObject({ provider: 'SMTP', configured: true, ok: false, messageId: null, previewUrl: null });
    expect(verdict.message).toContain('Username and Password not accepted');
    expect(verdict.message).not.toContain(SMTP_PASSWORD);
    expect(verdict.message).toContain('••••');
    expect(JSON.stringify(verdict)).not.toContain(SMTP_PASSWORD);
  });

  it('a Resend 4xx is a verdict: ok false with Resend`s own sentence, the key nowhere in it', async () => {
    config.getEffectiveEmailConfig.mockResolvedValue(smtp({ primary: 'RESEND' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ statusCode: 403, name: 'validation_error', message: `The ${RESEND_KEY} key is restricted to sending emails only` }) })),
    );
    const verdict = await testEmailDoor('ops@adx.co');
    expect(verdict).toMatchObject({ provider: 'RESEND', configured: true, ok: false });
    expect(verdict.message).toContain('403');
    expect(verdict.message).toContain('restricted to sending emails only');
    expect(verdict.message).not.toContain(RESEND_KEY);
    expect(JSON.stringify(verdict)).not.toContain(RESEND_KEY);
  });

  it('a door that does not answer in 15 s is a verdict, not a hang', async () => {
    vi.useFakeTimers();
    sendMailMock.mockImplementation(() => new Promise(() => undefined));
    const pending = testEmailDoor('ops@adx.co');
    await vi.advanceTimersByTimeAsync(EMAIL_TEST_TIMEOUT_MS + 1);
    const verdict = await pending;
    expect(EMAIL_TEST_TIMEOUT_MS).toBe(15_000);
    expect(verdict).toMatchObject({ provider: 'SMTP', configured: true, ok: false, message: 'The door did not answer in time' });
  });
});
