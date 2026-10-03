import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FB-1 — Continue with Facebook.
 *
 * What is pinned: the service trusts a token only when Facebook's
 * `debug_token` says it is live and issued for THIS app, then reads `/me`;
 * the door is register-or-login on the mailbox — a known address signs in
 * (an admin, or an account with an authenticator, gets the challenge), an
 * unknown one is handed to the phone step, and no email is a 409 that
 * names the other doors.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    verifyFacebookToken: vi.fn(),
    findLoginUsersByEmailInsensitive: vi.fn(),
    startSession: vi.fn(),
    logActivity: vi.fn(),
    issueChallenge: vi.fn(),
    signupHandoffForProvenEmail: vi.fn(),
    stampProvenEmail: vi.fn(),
  },
}));

vi.mock('../facebook.service', () => ({ verifyFacebookToken: mocks.verifyFacebookToken }));
vi.mock('../../prisma-auth.repository', () => ({ prismaAuthRepository: { findLoginUsersByEmailInsensitive: mocks.findLoginUsersByEmailInsensitive } }));
vi.mock('../../auth.session', () => ({ startSession: mocks.startSession, sessionMeta: vi.fn(() => ({ userAgent: 'vitest', ipAddress: '127.0.0.1' })) }));
vi.mock('../../../../shared/audit', () => ({ logActivity: mocks.logActivity }));
vi.mock('../../otp/otp.service', () => ({ signupHandoffForProvenEmail: mocks.signupHandoffForProvenEmail, stampProvenEmail: mocks.stampProvenEmail }));
vi.mock('../../two-factor/two-factor.service', async (importActual) => ({
  ...(await importActual<typeof import('../../two-factor/two-factor.service')>()),
  issueChallenge: mocks.issueChallenge,
}));

import { facebookLoginHandler } from '../facebook.controller';

const account = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919845012210',
  name: 'Riya',
  email: 'riya@asterhome.example',
  language: 'en',
  avatarUrl: null,
  passwordHash: null,
  isActive: true,
  totpSecretEnc: null,
  totpEnrolledAt: null,
  roles: [{ role: 'ADVERTISER' }],
  agentProfile: null,
  publisherProfile: null,
  advertiserProfile: { id: 'adv_1' },
  ...over,
});
const request = (body: Record<string, unknown>) => ({ body, headers: {}, ip: '127.0.0.1', method: 'POST' }) as never;
const response = () => {
  const res: Record<string, unknown> = {};
  res['json'] = vi.fn(() => res);
  res['status'] = vi.fn(() => res);
  res['set'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyFacebookToken.mockResolvedValue({ id: 'fb_1', email: 'riya@asterhome.example', name: 'Riya Mehta' });
  mocks.startSession.mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' });
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.stampProvenEmail.mockResolvedValue(undefined);
  mocks.signupHandoffForProvenEmail.mockResolvedValue({ kind: 'signup', signupToken: 'signup-1', email: 'riya@asterhome.example', expiresInSeconds: 1800 });
  mocks.issueChallenge.mockResolvedValue({ challengeToken: 'ch', methods: ['AUTHENTICATOR'], maskedMobile: null, maskedEmail: null });
});

describe('the service', () => {
  const config = async () => ({ appId: 'app_1', appSecret: 'secret' });
  const verifyFacebookToken = async (...args: Parameters<typeof import('../facebook.service')['verifyFacebookToken']>) =>
    (await vi.importActual<typeof import('../facebook.service')>('../facebook.service')).verifyFacebookToken(...args);
  const fetchOf = (answers: Record<string, { status: number; body: unknown }>) =>
    vi.fn(async (url: string) => {
      const key = Object.keys(answers).find((k) => url.includes(k));
      const answer = key ? answers[key]! : { status: 404, body: {} };
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

  it('trusts a live token issued for this app and reads the profile', async () => {
    const fetchImpl = fetchOf({
      debug_token: { status: 200, body: { data: { app_id: 'app_1', is_valid: true, user_id: 'fb_1' } } },
      '/me': { status: 200, body: { id: 'fb_1', name: 'Riya Mehta', email: 'Riya@AsterHome.example' } },
    });
    await expect(verifyFacebookToken('tok', { fetchImpl, config })).resolves.toEqual({ id: 'fb_1', email: 'riya@asterhome.example', name: 'Riya Mehta' });
    const [debugUrl] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(debugUrl).toContain('access_token=app_1%7Csecret');
  });

  it('refuses a token that is not live or was issued for another app, and answers no email as null', async () => {
    await expect(verifyFacebookToken('tok', { fetchImpl: fetchOf({ debug_token: { status: 200, body: { data: { app_id: 'other', is_valid: true } } } }), config })).rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyFacebookToken('tok', { fetchImpl: fetchOf({ debug_token: { status: 200, body: { data: { app_id: 'app_1', is_valid: false } } } }), config })).rejects.toMatchObject({ statusCode: 401 });
    const noEmail = fetchOf({ debug_token: { status: 200, body: { data: { app_id: 'app_1', is_valid: true } } }, '/me': { status: 200, body: { id: 'fb_2', name: 'Anon' } } });
    await expect(verifyFacebookToken('tok', { fetchImpl: noEmail, config })).resolves.toMatchObject({ id: 'fb_2', email: null });
  });

  it('is 503 until the app id and secret are set', async () => {
    await expect(verifyFacebookToken('tok', { fetchImpl: fetchOf({}), config: async () => ({}) })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('the door', () => {
  it('signs a known address in, stamping the mailbox as proved', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([account()]);
    const res = response();
    await facebookLoginHandler(request({ accessToken: 'tok' }), res as never);
    expect(mocks.stampProvenEmail).toHaveBeenCalledWith('usr_1', 'riya@asterhome.example');
    expect(mocks.startSession).toHaveBeenCalledWith('usr_1', ['ADVERTISER'], expect.anything());
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ accessToken: 'acc', user: expect.objectContaining({ id: 'usr_1' }) }) });
    expect(mocks.logActivity).toHaveBeenCalledWith('usr_1', 'LOGIN_FACEBOOK', expect.anything(), { facebookId: 'fb_1' });
  });

  it('hands a new address to the phone step, never opening an account here', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([]);
    const res = response();
    await facebookLoginHandler(request({ accessToken: 'tok' }), res as never);
    expect(mocks.signupHandoffForProvenEmail).toHaveBeenCalledWith('riya@asterhome.example');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { signup: { signupToken: 'signup-1', email: 'riya@asterhome.example', expiresInSeconds: 1800 } } });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('a Facebook account with no email is 409, naming the other doors', async () => {
    mocks.verifyFacebookToken.mockResolvedValue({ id: 'fb_2', email: null });
    await expect(facebookLoginHandler(request({ accessToken: 'tok' }), response() as never)).rejects.toMatchObject({ statusCode: 409, code: 'FACEBOOK_EMAIL_REQUIRED' });
    expect(mocks.findLoginUsersByEmailInsensitive).not.toHaveBeenCalled();
  });

  it('an admin, or an account with an authenticator, gets the challenge and no tokens', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([account({ roles: [{ role: 'ADMIN' }] })]);
    let res = response();
    await facebookLoginHandler(request({ accessToken: 'tok' }), res as never);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { challenge: expect.objectContaining({ challengeToken: 'ch' }) } });
    expect(mocks.startSession).not.toHaveBeenCalled();

    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([account({ totpSecretEnc: 'enc', totpEnrolledAt: new Date() })]);
    res = response();
    await facebookLoginHandler(request({ accessToken: 'tok' }), res as never);
    expect(mocks.issueChallenge).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'usr_1' }), { methods: ['AUTHENTICATOR'] });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('a deactivated account is refused', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([account({ isActive: false })]);
    await expect(facebookLoginHandler(request({ accessToken: 'tok' }), response() as never)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('account lifecycle (2 Oct 2026): a closed account is refused the same way', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([account({ isActive: true, closedAt: new Date() })]);
    await expect(facebookLoginHandler(request({ accessToken: 'tok' }), response() as never)).rejects.toMatchObject({ statusCode: 401 });
  });
});
