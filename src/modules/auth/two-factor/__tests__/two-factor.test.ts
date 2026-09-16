import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A, Q25 — the admin second factor.
 *
 * What is pinned: an ADMIN's password or Google sign-in answers with a
 * challenge rather than tokens and nobody else is affected; the challenge
 * token is not an access token; SMS goes through the ordinary OTP path; the
 * email code is ten characters from the unambiguous alphabet and is read
 * case-insensitively; the email backup is counted and refused at the limit;
 * and a phone code earns the backup back.
 */
const { repository, otp, otpSecurity, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findUser: vi.fn(),
    stampTwoFactorRequired: vi.fn(),
    findLatestTwoFactorOtp: vi.fn(),
    expireOutstandingTwoFactorEmail: vi.fn(),
    createEmailCode: vi.fn(),
    incrementAttempts: vi.fn(),
    markVerified: vi.fn(),
    countEmailFallback: vi.fn(),
    resetEmailFallback: vi.fn(),
  },
  otp: { sendOtp: vi.fn(), verifyOtp: vi.fn(), normalizeMobile: vi.fn((m: string) => m) },
  otpSecurity: {
    reserveOtpSend: vi.fn(),
    OtpError: class OtpError extends Error {
      reason = 'OTP_RESEND_TOO_SOON';
    },
  },
  notifications: { notify: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-two-factor.repository', () => ({ prismaTwoFactorRepository: repository }));
vi.mock('../../otp/otp.service', () => otp);
vi.mock('../../otp/otp-security', () => otpSecurity);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../../../config/env';
import { verifyAccessToken } from '../../../../shared/auth';
import {
  EMAIL_CODE_ALPHABET,
  EMAIL_CODE_LENGTH,
  generateEmailCode,
  isAdmin,
  issueChallenge,
  maskEmail,
  maskMobile,
  readChallenge,
  sendTwoFactorCode,
  verifyTwoFactorCode,
} from '../two-factor.service';

const admin = (over: Record<string, unknown> = {}) => ({
  id: 'adm_1',
  mobile: '+919845012210',
  email: 'asha.rao@adx.co',
  isActive: true,
  emailOtpFallbackCount: 0,
  emailOtpFallbackResetAt: null,
  roles: [{ role: 'ADMIN' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findUser.mockResolvedValue(admin());
  repository.stampTwoFactorRequired.mockResolvedValue({});
  repository.countEmailFallback.mockResolvedValue(1);
  repository.resetEmailFallback.mockResolvedValue({});
  repository.expireOutstandingTwoFactorEmail.mockResolvedValue({});
  repository.createEmailCode.mockResolvedValue({});
  repository.markVerified.mockResolvedValue({});
  otp.sendOtp.mockResolvedValue({ expiresInSeconds: 600, resendAfterSeconds: 60, sendsRemaining: 2 });
  otp.verifyOtp.mockResolvedValue('adm_1');
  otpSecurity.reserveOtpSend.mockResolvedValue({ resendAfterSeconds: 60, sendsRemaining: 2 });
  notifications.notify.mockResolvedValue({ notificationId: null, templateKey: 'two-factor-email', deliveries: [] });
});

describe('the challenge', () => {
  it('names the account, masks both channels and stamps that 2FA is on', async () => {
    const challenge = await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' });
    expect(repository.stampTwoFactorRequired).toHaveBeenCalledWith('adm_1');
    expect(challenge.methods).toEqual(['SMS', 'EMAIL']);
    expect(challenge.maskedMobile).toBe('+91 ***** 2210');
    expect(challenge.maskedEmail).toBe('a******o@adx.co');
    expect(readChallenge(challenge.challengeToken)).toBe('adm_1');
  });

  it('offers only SMS once the email backup is spent, so no button answers 403', async () => {
    repository.findUser.mockResolvedValue(admin({ emailOtpFallbackCount: 3, emailOtpFallbackResetAt: new Date() }));
    const challenge = await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' });
    expect(challenge.methods).toEqual(['SMS']);
  });

  it('is not an access token — authenticate() must refuse it', async () => {
    const { challengeToken } = await issueChallenge({ id: 'adm_1', mobile: '+91', email: null });
    expect(() => verifyAccessToken(challengeToken)).toThrow();
  });

  it('refuses anything that is not a live challenge', () => {
    expect(() => readChallenge('nonsense')).toThrow();
    const access = jwt.sign({ sub: 'adm_1', roles: ['ADMIN'] }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    expect(() => readChallenge(access)).toThrow();
  });

  it('masks sensibly at the edges', () => {
    expect(maskMobile(null)).toBeNull();
    expect(maskEmail('ab@adx.co')).toBe('a***@adx.co');
    expect(maskEmail(null)).toBeNull();
  });

  it('recognises an admin from either shape of role list', () => {
    expect(isAdmin(['PUBLISHER', 'ADMIN'])).toBe(true);
    expect(isAdmin([{ role: 'PUBLISHER' }])).toBe(false);
  });
});

describe('sending the code', () => {
  const challengeFor = async () => (await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' })).challengeToken;

  it('sends SMS through the ordinary OTP path, so the budget and lockout apply', async () => {
    const result = await sendTwoFactorCode(await challengeFor(), 'SMS');
    expect(otp.sendOtp).toHaveBeenCalledWith('+919845012210', 'TWO_FACTOR');
    expect(result).toMatchObject({ method: 'SMS', resendAfterSeconds: 60 });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_SENT', expect.objectContaining({ metadata: { method: 'SMS' } }));
  });

  it('sends a ten-character email code from the unambiguous alphabet, counted against the backup', async () => {
    const result = await sendTwoFactorCode(await challengeFor(), 'EMAIL');
    expect(otpSecurity.reserveOtpSend).toHaveBeenCalledWith('asha.rao@adx.co');
    expect(repository.countEmailFallback).toHaveBeenCalled();
    expect(repository.createEmailCode).toHaveBeenCalled();
    // Lot E (Q147): through the dispatcher, sent in the request, to the address on file.
    expect(notifications.notify).toHaveBeenCalledWith(
      'TWO_FACTOR_EMAIL',
      'adm_1',
      expect.objectContaining({ code: result.devCode, minutes: expect.any(Number) }),
      expect.objectContaining({ type: 'SYSTEM', recipient: { email: 'asha.rao@adx.co' }, immediate: true }),
    );
    expect(result.method).toBe('EMAIL');
    expect(result.devCode).toMatch(new RegExp(`^[${EMAIL_CODE_ALPHABET}]{${EMAIL_CODE_LENGTH}}$`));
  });

  it('refuses email once the counter is at the limit, and again if the row says so already', async () => {
    repository.countEmailFallback.mockResolvedValue(env.ADMIN_EMAIL_OTP_FALLBACK_LIMIT + 1);
    await expect(sendTwoFactorCode(await challengeFor(), 'EMAIL')).rejects.toMatchObject({
      statusCode: 403,
      code: 'MOBILE_VERIFICATION_REQUIRED',
      details: { methods: ['SMS'] },
    });
    expect(notifications.notify).not.toHaveBeenCalled();

    repository.findUser.mockResolvedValue(admin({ emailOtpFallbackCount: 3, emailOtpFallbackResetAt: new Date() }));
    await expect(sendTwoFactorCode(await challengeFor(), 'EMAIL')).rejects.toMatchObject({ code: 'MOBILE_VERIFICATION_REQUIRED' });
    expect(repository.countEmailFallback).toHaveBeenCalledTimes(1);
  });

  it('lets the counter lapse after the window', async () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    repository.findUser.mockResolvedValue(admin({ emailOtpFallbackCount: 9, emailOtpFallbackResetAt: longAgo }));
    await expect(sendTwoFactorCode(await challengeFor(), 'EMAIL')).resolves.toMatchObject({ method: 'EMAIL' });
  });

  it('refuses a challenge for an account that is no longer an active admin', async () => {
    const token = await challengeFor();
    repository.findUser.mockResolvedValue(admin({ isActive: false }));
    await expect(sendTwoFactorCode(token, 'SMS')).rejects.toMatchObject({ statusCode: 401 });
    repository.findUser.mockResolvedValue(admin({ roles: [{ role: 'PUBLISHER' }] }));
    await expect(sendTwoFactorCode(token, 'SMS')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('generates codes with no 0, O, 1 or I', () => {
    for (let i = 0; i < 50; i += 1) expect(generateEmailCode()).not.toMatch(/[01OI]/);
  });
});

describe('verifying the code', () => {
  const challengeFor = async () => (await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' })).challengeToken;

  it('takes an SMS code through the OTP service and earns the email backup back', async () => {
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_1', purpose: 'TWO_FACTOR', attempts: 0, codeHash: 'x' });
    const result = await verifyTwoFactorCode(await challengeFor(), '123456');
    expect(otp.verifyOtp).toHaveBeenCalledWith('+919845012210', '123456', 'TWO_FACTOR');
    expect(repository.resetEmailFallback).toHaveBeenCalledWith('adm_1');
    expect(result).toEqual({ userId: 'adm_1', roles: ['ADMIN'], method: 'SMS' });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_PASSED', expect.anything());
  });

  it('takes an email code in any case, and consumes it', async () => {
    const codeHash = await bcrypt.hash('ABCD23WXYZ', 10);
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_2', purpose: 'TWO_FACTOR_EMAIL', attempts: 0, codeHash });
    const result = await verifyTwoFactorCode(await challengeFor(), ' abcd23wxyz ');
    expect(repository.markVerified).toHaveBeenCalledWith('otp_2');
    expect(result.method).toBe('EMAIL');
    // Only a phone code earns the backup back.
    expect(repository.resetEmailFallback).not.toHaveBeenCalled();
  });

  it('counts a wrong email code against it and logs the failure', async () => {
    const codeHash = await bcrypt.hash('ABCD23WXYZ', 10);
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_2', purpose: 'TWO_FACTOR_EMAIL', attempts: 0, codeHash });
    await expect(verifyTwoFactorCode(await challengeFor(), 'WRONGCODE2')).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.incrementAttempts).toHaveBeenCalledWith('otp_2');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_FAILED', expect.anything());
  });

  it('stops an email code after five guesses, and refuses when there is no live code at all', async () => {
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_2', purpose: 'TWO_FACTOR_EMAIL', attempts: 5, codeHash: 'x' });
    await expect(verifyTwoFactorCode(await challengeFor(), 'ABCD23WXYZ')).rejects.toMatchObject({ statusCode: 401 });

    repository.findLatestTwoFactorOtp.mockResolvedValue(null);
    await expect(verifyTwoFactorCode(await challengeFor(), 'ABCD23WXYZ')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('lets an SMS failure through as the OTP service reported it', async () => {
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_1', purpose: 'TWO_FACTOR', attempts: 0, codeHash: 'x' });
    otp.verifyOtp.mockRejectedValue(Object.assign(new Error('locked'), { statusCode: 429 }));
    await expect(verifyTwoFactorCode(await challengeFor(), '000000')).rejects.toMatchObject({ statusCode: 429 });
    expect(repository.resetEmailFallback).not.toHaveBeenCalled();
  });
});
