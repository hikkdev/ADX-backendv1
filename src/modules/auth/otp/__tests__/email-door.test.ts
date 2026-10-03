import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../../../config/env';

/**
 * ED-1 (the owner, 25 Sep 2026) — the email door.
 *
 * What is pinned: `sendEmailOtp` is register-or-login — a known address gets
 * its login code as before, an unknown one gets a sign-up code filed in
 * `EmailSignup` and mailed to the bare address; `verifyEmailDoor` answers the
 * account for a known address (stamping `emailVerifiedAt`) and a signup
 * token for an unknown one, refusing with the OTP vocabulary either way; and
 * `attachSignupEmail` writes the proven address onto the account the phone
 * step just signed in — PRIMARY, or KEPT / TAKEN / EXPIRED when it cannot.
 */
const { repository, security, notifications, audit } = vi.hoisted(() => ({
  repository: {
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    expireOutstandingByEmail: vi.fn(),
    createForEmail: vi.fn(),
    findLatestUnverifiedByEmail: vi.fn(),
    incrementAttempts: vi.fn(),
    markVerified: vi.fn(),
    markEmailVerified: vi.fn(),
    findEmailSignup: vi.fn(),
    upsertEmailSignup: vi.fn(),
    incrementEmailSignupAttempts: vi.fn(),
    markEmailSignupVerified: vi.fn(),
    deleteEmailSignup: vi.fn(),
    setPrimaryEmailVerified: vi.fn(),
    findEmailHolder: vi.fn(),
  },
  security: {
    OtpError: class OtpError extends Error {
      statusCode: number;
      reason: string;
      details: Record<string, unknown>;
      constructor(statusCode: number, message: string, details: { reason: string }) {
        super(message);
        this.statusCode = statusCode;
        this.reason = details.reason;
        this.details = details;
      }
    },
    assertOtpNotLocked: vi.fn(),
    clearOtpFailures: vi.fn(),
    registerOtpFailure: vi.fn(),
    reserveOtpSend: vi.fn(),
  },
  notifications: { notify: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-otp.repository', () => ({ prismaOtpRepository: repository }));
vi.mock('../otp-security', () => security);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../auth.ports', () => ({ mobileWasErased: vi.fn(async () => false) }));

import { attachSignupEmail, sendEmailOtp, verifyEmailDoor, verifyEmailOtp } from '../otp.service';

const user = (over: Record<string, unknown> = {}) => ({ id: 'usr_1', mobile: '+919845012210', email: null, emailVerifiedAt: null, ...over });

const signupRow = async (code: string, over: Record<string, unknown> = {}) => ({
  id: 'sig_1',
  email: 'new@adx.in',
  codeHash: await bcrypt.hash(code, 4),
  attempts: 0,
  expiresAt: new Date(Date.now() + 60_000),
  verifiedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const signupToken = (over: Record<string, unknown> = {}) =>
  jwt.sign({ sub: 'sig_1', email: 'new@adx.in', purpose: 'EMAIL_SIGNUP', ...over }, env.JWT_ACCESS_SECRET, { expiresIn: 600 });

beforeEach(() => {
  vi.clearAllMocks();
  security.assertOtpNotLocked.mockResolvedValue(undefined);
  security.reserveOtpSend.mockResolvedValue({ resendAfterSeconds: 60, sendsRemaining: 2 });
  security.registerOtpFailure.mockResolvedValue({ locked: false, attemptsRemaining: 3 });
  security.clearOtpFailures.mockResolvedValue(undefined);
  repository.expireOutstandingByEmail.mockResolvedValue(undefined);
  repository.createForEmail.mockResolvedValue({});
  repository.incrementAttempts.mockResolvedValue({});
  repository.markVerified.mockResolvedValue({});
  repository.markEmailVerified.mockResolvedValue({ count: 1 });
  repository.upsertEmailSignup.mockResolvedValue({ id: 'sig_1' });
  repository.incrementEmailSignupAttempts.mockResolvedValue({});
  repository.markEmailSignupVerified.mockResolvedValue({});
  repository.deleteEmailSignup.mockResolvedValue({ count: 1 });
  repository.setPrimaryEmailVerified.mockResolvedValue({});
  repository.findEmailHolder.mockResolvedValue(null);
  notifications.notify.mockResolvedValue({});
  audit.logActivity.mockResolvedValue(undefined);
});

describe('sendEmailOtp — register-or-login', () => {
  it('an unknown address gets a sign-up code, filed on its own row and mailed to the bare address', async () => {
    repository.findUserByEmail.mockResolvedValue(null);
    const result = await sendEmailOtp('  New@ADX.in ');

    expect(security.assertOtpNotLocked).toHaveBeenCalledWith('new@adx.in');
    expect(security.reserveOtpSend).toHaveBeenCalledWith('new@adx.in');
    expect(repository.createForEmail).not.toHaveBeenCalled();
    expect(repository.upsertEmailSignup).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@adx.in', codeHash: expect.any(String), expiresAt: expect.any(Date) }));
    expect(notifications.notify).toHaveBeenCalledWith(
      'LOGIN_OTP_EMAIL',
      null,
      { code: expect.stringMatching(/^[A-HJ-NP-Z]{8}$/), minutes: 10 },
      { type: 'SYSTEM', recipient: { email: 'new@adx.in' }, immediate: true },
    );
    expect(result).toMatchObject({ expiresInSeconds: 600, resendAfterSeconds: 60, sendsRemaining: 2 });
    const { codeHash } = repository.upsertEmailSignup.mock.calls[0]![0] as { codeHash: string };
    expect(await bcrypt.compare(result.devOtp!, codeHash)).toBe(true);
  });

  it('a known address gets its login code, exactly as before, on the same budget', async () => {
    repository.findUserByEmail.mockResolvedValue(user({ email: 'asha@adx.in' }));
    const result = await sendEmailOtp('Asha@ADX.in');

    expect(repository.upsertEmailSignup).not.toHaveBeenCalled();
    expect(repository.createForEmail).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_1', email: 'asha@adx.in' }));
    expect(notifications.notify).toHaveBeenCalledWith('LOGIN_OTP_EMAIL', 'usr_1', expect.anything(), expect.objectContaining({ recipient: { email: 'asha@adx.in' } }));
    expect(result).toMatchObject({ expiresInSeconds: 600, resendAfterSeconds: 60 });
  });
});

describe('verifyEmailDoor', () => {
  it('a known address answers its account and stamps the email verified', async () => {
    repository.findUserByEmail.mockResolvedValue(user({ email: 'asha@adx.in' }));
    repository.findLatestUnverifiedByEmail.mockResolvedValue({ id: 'otp_1', userId: 'usr_1', codeHash: await bcrypt.hash('123456', 4), attempts: 0 });

    await expect(verifyEmailDoor('Asha@ADX.in', '123456')).resolves.toEqual({ kind: 'account', userId: 'usr_1' });
    expect(repository.markVerified).toHaveBeenCalledWith('otp_1');
    expect(repository.markEmailVerified).toHaveBeenCalledWith('usr_1', 'asha@adx.in');
    expect(security.clearOtpFailures).toHaveBeenCalledWith('asha@adx.in');
  });

  it('a known address with a wrong code counts against the address and answers OTP_INVALID', async () => {
    repository.findUserByEmail.mockResolvedValue(user({ email: 'asha@adx.in' }));
    repository.findLatestUnverifiedByEmail.mockResolvedValue({ id: 'otp_1', userId: 'usr_1', codeHash: await bcrypt.hash('123456', 4), attempts: 0 });

    await expect(verifyEmailOtp('asha@adx.in', '000000')).rejects.toMatchObject({ statusCode: 401, reason: 'OTP_INVALID' });
    expect(repository.incrementAttempts).toHaveBeenCalledWith('otp_1');
    expect(security.registerOtpFailure).toHaveBeenCalledWith('asha@adx.in');
    expect(repository.markEmailVerified).not.toHaveBeenCalled();
  });

  it('an unknown address with the right code answers a signup token that names the address', async () => {
    repository.findUserByEmail.mockResolvedValue(null);
    repository.findEmailSignup.mockResolvedValue(await signupRow('654321'));

    const answer = await verifyEmailDoor('new@adx.in', '654321');
    expect(answer.kind).toBe('signup');
    if (answer.kind !== 'signup') throw new Error('unreachable');
    expect(answer).toMatchObject({ email: 'new@adx.in', expiresInSeconds: 1800 });
    const claims = jwt.verify(answer.signupToken, env.JWT_ACCESS_SECRET) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: 'sig_1', email: 'new@adx.in', purpose: 'EMAIL_SIGNUP' });
    expect(repository.markEmailSignupVerified).toHaveBeenCalledWith('sig_1');
    expect(security.clearOtpFailures).toHaveBeenCalledWith('new@adx.in');
  });

  it('an unknown address with a wrong code counts the guess on the row and against the address', async () => {
    repository.findUserByEmail.mockResolvedValue(null);
    repository.findEmailSignup.mockResolvedValue(await signupRow('654321'));

    await expect(verifyEmailDoor('new@adx.in', '111111')).rejects.toMatchObject({ statusCode: 401, reason: 'OTP_INVALID' });
    expect(repository.incrementEmailSignupAttempts).toHaveBeenCalledWith('sig_1');
    expect(security.registerOtpFailure).toHaveBeenCalledWith('new@adx.in');
  });

  it('a spent, stale or missing sign-up row is OTP_EXPIRED; a fifth guess is OTP_ATTEMPTS_EXCEEDED', async () => {
    repository.findUserByEmail.mockResolvedValue(null);
    repository.findEmailSignup.mockResolvedValue(null);
    await expect(verifyEmailDoor('new@adx.in', '654321')).rejects.toMatchObject({ reason: 'OTP_EXPIRED' });
    repository.findEmailSignup.mockResolvedValue(await signupRow('654321', { verifiedAt: new Date() }));
    await expect(verifyEmailDoor('new@adx.in', '654321')).rejects.toMatchObject({ reason: 'OTP_EXPIRED' });
    repository.findEmailSignup.mockResolvedValue(await signupRow('654321', { expiresAt: new Date(Date.now() - 1) }));
    await expect(verifyEmailDoor('new@adx.in', '654321')).rejects.toMatchObject({ reason: 'OTP_EXPIRED' });
    repository.findEmailSignup.mockResolvedValue(await signupRow('654321', { attempts: 5 }));
    await expect(verifyEmailDoor('new@adx.in', '654321')).rejects.toMatchObject({ reason: 'OTP_ATTEMPTS_EXCEEDED' });
  });
});

describe('attachSignupEmail — the phone step at the end of an email sign-up', () => {
  it('PRIMARY: a free address becomes the verified primary email, the row is spent, the audit row written', async () => {
    repository.findEmailSignup.mockResolvedValue(await signupRow('x', { verifiedAt: new Date() }));
    repository.findUserById.mockResolvedValue(user());

    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toEqual({ email: 'new@adx.in', attached: true, outcome: 'PRIMARY' });
    expect(repository.setPrimaryEmailVerified).toHaveBeenCalledWith('usr_1', 'new@adx.in');
    expect(repository.deleteEmailSignup).toHaveBeenCalledWith('sig_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'EMAIL_VERIFIED', expect.objectContaining({ module: 'auth', metadata: expect.objectContaining({ email: 'new@adx.in', via: 'EMAIL_DOOR' }) }));
  });

  it('PRIMARY replaces an unverified email the account held; KEPT leaves a verified one alone', async () => {
    repository.findEmailSignup.mockResolvedValue(await signupRow('x', { verifiedAt: new Date() }));
    repository.findUserById.mockResolvedValue(user({ email: 'old@adx.in', emailVerifiedAt: null }));
    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toMatchObject({ attached: true, outcome: 'PRIMARY' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'EMAIL_VERIFIED', expect.objectContaining({ metadata: expect.objectContaining({ replaced: 'old@adx.in' }) }));

    vi.clearAllMocks();
    repository.findEmailSignup.mockResolvedValue(await signupRow('x', { verifiedAt: new Date() }));
    repository.findUserById.mockResolvedValue(user({ email: 'old@adx.in', emailVerifiedAt: new Date() }));
    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toEqual({ email: 'new@adx.in', attached: false, outcome: 'KEPT' });
    expect(repository.setPrimaryEmailVerified).not.toHaveBeenCalled();
    expect(repository.deleteEmailSignup).toHaveBeenCalledWith('sig_1');
  });

  it('TAKEN: another account took the address in between; the row is spent and nothing is written', async () => {
    repository.findEmailSignup.mockResolvedValue(await signupRow('x', { verifiedAt: new Date() }));
    repository.findEmailHolder.mockResolvedValue({ which: 'PRIMARY', userId: 'usr_2' });

    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toEqual({ email: 'new@adx.in', attached: false, outcome: 'TAKEN' });
    expect(repository.setPrimaryEmailVerified).not.toHaveBeenCalled();
    expect(repository.deleteEmailSignup).toHaveBeenCalledWith('sig_1');
  });

  it('EXPIRED: a token that is not ours, a row that is gone, or a row the code never proved', async () => {
    await expect(attachSignupEmail('usr_1', 'not-a-token')).resolves.toEqual({ email: null, attached: false, outcome: 'EXPIRED' });
    await expect(attachSignupEmail('usr_1', jwt.sign({ sub: 'sig_1', email: 'new@adx.in', purpose: 'TWO_FACTOR' }, env.JWT_ACCESS_SECRET))).resolves.toMatchObject({ outcome: 'EXPIRED' });
    repository.findEmailSignup.mockResolvedValue(null);
    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toEqual({ email: 'new@adx.in', attached: false, outcome: 'EXPIRED' });
    repository.findEmailSignup.mockResolvedValue(await signupRow('x', { verifiedAt: null }));
    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toMatchObject({ outcome: 'EXPIRED' });
    repository.findEmailSignup.mockResolvedValue(await signupRow('x', { id: 'sig_other', verifiedAt: new Date() }));
    await expect(attachSignupEmail('usr_1', signupToken())).resolves.toMatchObject({ outcome: 'EXPIRED' });
    expect(repository.setPrimaryEmailVerified).not.toHaveBeenCalled();
  });
});
