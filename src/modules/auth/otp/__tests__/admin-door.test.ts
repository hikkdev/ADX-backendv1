import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M-B — the one-factor doors an ADMIN could walk through.
 *
 * What is pinned: `POST /auth/verify-otp` answers an admin with the
 * second-factor challenge (bounded by the door — see the two-factor suite)
 * and never with tokens, or 403 ADMIN_SIGN_IN_REQUIRED when nothing can
 * answer it; `POST /auth/verify-otp-email` and the publisher app's
 * `POST /auth/publisher/verify-otp` refuse an admin outright with the same
 * code, naming the console login; and nobody else is affected.
 */
const { otpService, repository, session, twoFactor, audit, tokens } = vi.hoisted(() => ({
  otpService: { sendOtp: vi.fn(), verifyOtp: vi.fn(), sendEmailOtp: vi.fn(), verifyEmailOtp: vi.fn(), normalizeMobile: vi.fn((m: string) => m) },
  repository: { findLoginUserById: vi.fn(), findPublisherLoginUserById: vi.fn(), recordLogin: vi.fn(), setName: vi.fn() },
  session: { startSession: vi.fn(), sessionMeta: vi.fn(() => ({ userAgent: 'vitest', ipAddress: '127.0.0.1' })) },
  twoFactor: { issueChallengeAfterMobileOtp: vi.fn() },
  audit: { logActivity: vi.fn() },
  tokens: { issueRefreshToken: vi.fn() },
}));

vi.mock('../otp.service', () => otpService);
vi.mock('../../prisma-auth.repository', () => ({ prismaAuthRepository: repository }));
vi.mock('../../auth.session', () => session);
vi.mock('../../tokens/tokens.service', () => tokens);
vi.mock('../../../../shared/audit', () => audit);
// Partial: `isAdmin` and `adminSignInRequired` stay real — they are the rule under test.
vi.mock('../../two-factor/two-factor.service', async (importActual) => ({
  ...(await importActual<typeof import('../../two-factor/two-factor.service')>()),
  issueChallengeAfterMobileOtp: twoFactor.issueChallengeAfterMobileOtp,
}));

import { verifyOtpEmailHandler, verifyOtpHandler } from '../otp.controller';
import { publisherVerifyOtpHandler } from '../../publisher/publisher-auth.controller';
import { adminSignInRequired } from '../../two-factor/two-factor.service';

const account = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919845012210',
  name: 'Asha',
  email: 'asha@adx.co',
  language: 'en',
  avatarUrl: null,
  passwordHash: 'x',
  isActive: true,
  totpSecretEnc: null,
  totpEnrolledAt: null,
  roles: [{ role: 'PUBLISHER' }],
  agentProfile: null,
  publisherProfile: { id: 'pub_1' },
  advertiserProfile: null,
  ...over,
});
const admin = (over: Record<string, unknown> = {}) => account({ id: 'adm_1', roles: [{ role: 'ADMIN' }], ...over });

const request = (body: Record<string, unknown>) => ({ body, headers: {}, ip: '127.0.0.1', method: 'POST' }) as never;
const response = () => {
  const res: Record<string, unknown> = {};
  res['json'] = vi.fn(() => res);
  res['set'] = vi.fn(() => res);
  res['status'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
};

const CHALLENGE = { challengeToken: 'challenge-token', methods: ['EMAIL'], maskedMobile: '+91 ***** 2210', maskedEmail: 'a**a@adx.co' };

beforeEach(() => {
  vi.clearAllMocks();
  otpService.verifyOtp.mockResolvedValue('usr_1');
  otpService.verifyEmailOtp.mockResolvedValue('usr_1');
  repository.findLoginUserById.mockResolvedValue(account());
  repository.findPublisherLoginUserById.mockResolvedValue(account());
  repository.recordLogin.mockResolvedValue({});
  session.startSession.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
  tokens.issueRefreshToken.mockResolvedValue({ raw: 'refresh', sessionId: 'ses_1' });
  twoFactor.issueChallengeAfterMobileOtp.mockResolvedValue(CHALLENGE);
});

describe('POST /auth/verify-otp', () => {
  it('still signs a publisher in with the token pair', async () => {
    const res = response();
    await verifyOtpHandler(request({ mobile: '+919845012210', otp: '123456' }), res as never);
    expect(session.startSession).toHaveBeenCalledWith('usr_1', ['PUBLISHER'], expect.anything());
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ accessToken: 'access', refreshToken: 'refresh' }) });
    expect(twoFactor.issueChallengeAfterMobileOtp).not.toHaveBeenCalled();
  });

  it('answers an ADMIN with the challenge — the same shape the password login answers — and starts no session', async () => {
    otpService.verifyOtp.mockResolvedValue('adm_1');
    repository.findLoginUserById.mockResolvedValue(admin());
    const res = response();
    await verifyOtpHandler(request({ mobile: '+919845012210', otp: '123456' }), res as never);
    expect(twoFactor.issueChallengeAfterMobileOtp).toHaveBeenCalledWith(expect.objectContaining({ id: 'adm_1', mobile: '+919845012210', email: 'asha@adx.co' }));
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { challenge: CHALLENGE } });
    expect(JSON.stringify(res.json.mock.calls[0])).not.toContain('accessToken');
    expect(session.startSession).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_CHALLENGED', expect.anything(), { method: 'otp' });
    expect(audit.logActivity).not.toHaveBeenCalledWith('adm_1', 'LOGIN_OTP', expect.anything());
  });

  it('an admin whom nothing can second is refused 403 ADMIN_SIGN_IN_REQUIRED, naming the console login', async () => {
    otpService.verifyOtp.mockResolvedValue('adm_1');
    repository.findLoginUserById.mockResolvedValue(admin());
    twoFactor.issueChallengeAfterMobileOtp.mockRejectedValue(adminSignInRequired());
    await expect(verifyOtpHandler(request({ mobile: '+919845012210', otp: '123456' }), response() as never)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ADMIN_SIGN_IN_REQUIRED',
      details: { loginAt: '/api/v1/auth/login-password', methods: ['PASSWORD', 'GOOGLE'] },
    });
    expect(session.startSession).not.toHaveBeenCalled();
  });

  it('an account holding ADMIN beside a party role is an admin here too', async () => {
    otpService.verifyOtp.mockResolvedValue('adm_1');
    repository.findLoginUserById.mockResolvedValue(admin({ roles: [{ role: 'PUBLISHER' }, { role: 'ADMIN' }] }));
    const res = response();
    await verifyOtpHandler(request({ mobile: '+919845012210', otp: '123456' }), res as never);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { challenge: CHALLENGE } });
    expect(session.startSession).not.toHaveBeenCalled();
  });
});

describe('POST /auth/verify-otp-email', () => {
  it('still signs a non-admin in', async () => {
    const res = response();
    await verifyOtpEmailHandler(request({ email: 'asha@adx.co', otp: '123456' }), res as never);
    expect(session.startSession).toHaveBeenCalledWith('usr_1', ['PUBLISHER'], expect.anything());
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ accessToken: 'access' }) });
  });

  it('refuses an ADMIN with 403 ADMIN_SIGN_IN_REQUIRED and no session, and records the attempt', async () => {
    otpService.verifyEmailOtp.mockResolvedValue('adm_1');
    repository.findLoginUserById.mockResolvedValue(admin());
    await expect(verifyOtpEmailHandler(request({ email: 'asha@adx.co', otp: '123456' }), response() as never)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ADMIN_SIGN_IN_REQUIRED',
      message: expect.stringContaining('console'),
    });
    expect(session.startSession).not.toHaveBeenCalled();
    expect(twoFactor.issueChallengeAfterMobileOtp).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_FAILED', expect.anything(), { method: 'otp_email', reason: 'ADMIN_SIGN_IN_REQUIRED' });
  });
});

describe('POST /auth/publisher/verify-otp', () => {
  it('falls back to the LOGIN code and signs a publisher in, as before', async () => {
    const res = response();
    await publisherVerifyOtpHandler(request({ mobile: '+919845012210', otp: '123456' }), res as never);
    expect(tokens.issueRefreshToken).toHaveBeenCalledWith('usr_1');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ refreshToken: 'refresh' }) });
  });

  it('refuses an ADMIN — the same LOGIN code would otherwise open the account from the publisher app', async () => {
    otpService.verifyOtp.mockResolvedValue('adm_1');
    repository.findPublisherLoginUserById.mockResolvedValue(admin({ roles: [{ role: 'PUBLISHER' }, { role: 'ADMIN' }] }));
    await expect(publisherVerifyOtpHandler(request({ mobile: '+919845012210', otp: '123456' }), response() as never)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ADMIN_SIGN_IN_REQUIRED',
    });
    expect(tokens.issueRefreshToken).not.toHaveBeenCalled();
    expect(repository.recordLogin).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_FAILED', expect.anything(), { method: 'publisher_otp', reason: 'ADMIN_SIGN_IN_REQUIRED' });
  });
});
