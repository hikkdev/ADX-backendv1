import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * K-B1 — the code to a contact the account does NOT sign in with.
 *
 * What is pinned: the email sender files the code under the caller's purpose
 * against the normalised address, spends the same per-recipient budget and
 * goes out as the `login-otp-email` mail (no template of its own); the
 * verifier answers the user id the code was issued for, counts a wrong guess
 * against the address, and refuses an expired or spent code with the OTP
 * vocabulary; `CONTACT_VERIFY_PURPOSE` is the enum's own CONTACT_VERIFY
 * (Lot K2); and a mobile change expires every live code the account holds.
 */

const { repository, security, notifications } = vi.hoisted(() => ({
  repository: {
    expireOutstandingByEmail: vi.fn(),
    createForEmail: vi.fn(),
    findLatestUnverifiedByEmail: vi.fn(),
    incrementAttempts: vi.fn(),
    markVerified: vi.fn(),
    expireOutstandingForUser: vi.fn(),
    hasVerifiedEmail: vi.fn(),
  },
  security: {
    OtpError: class OtpError extends Error {
      statusCode: number;
      reason: string;
      constructor(statusCode: number, message: string, details: { reason: string }) {
        super(message);
        this.statusCode = statusCode;
        this.reason = details.reason;
      }
    },
    assertOtpNotLocked: vi.fn(),
    clearOtpFailures: vi.fn(),
    registerOtpFailure: vi.fn(),
    reserveOtpSend: vi.fn(),
  },
  notifications: { notify: vi.fn() },
}));

vi.mock('../prisma-otp.repository', () => ({ prismaOtpRepository: repository }));
vi.mock('../otp-security', () => security);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => ({ logActivity: vi.fn() }));
vi.mock('../../auth.ports', () => ({ mobileWasErased: vi.fn(async () => false) }));

import { CONTACT_VERIFY_PURPOSE, expireOutstandingOtpsForUser, hasProvenEmail, sendEmailCodeToAddressForUser, verifyEmailCodeFor } from '../otp.service';

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
  repository.expireOutstandingForUser.mockResolvedValue({ count: 2 });
  notifications.notify.mockResolvedValue({});
});

describe('CONTACT_VERIFY_PURPOSE', () => {
  it('is its own OtpPurpose value now that the enum has it (Lot K2)', () => {
    expect(CONTACT_VERIFY_PURPOSE).toBe('CONTACT_VERIFY');
  });
});

describe('sendEmailCodeToAddressForUser', () => {
  it('files a six-digit code under the purpose against the normalised address and mails it as the login-code template', async () => {
    const result = await sendEmailCodeToAddressForUser('usr_1', '  Asha@Work.CO ', CONTACT_VERIFY_PURPOSE);

    expect(security.assertOtpNotLocked).toHaveBeenCalledWith('asha@work.co');
    expect(security.reserveOtpSend).toHaveBeenCalledWith('asha@work.co');
    expect(repository.expireOutstandingByEmail).toHaveBeenCalledWith('asha@work.co', 'CONTACT_VERIFY');
    expect(repository.createForEmail).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_1', email: 'asha@work.co', purpose: 'CONTACT_VERIFY', codeHash: expect.any(String), expiresAt: expect.any(Date) }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      'LOGIN_OTP_EMAIL',
      'usr_1',
      { code: expect.stringMatching(/^\d{6}$/), minutes: 10 },
      { type: 'SYSTEM', recipient: { email: 'asha@work.co' }, immediate: true },
    );
    expect(result).toMatchObject({ expiresInSeconds: 600, resendAfterSeconds: 60, sendsRemaining: 2 });
    // Outside production the code rides back for the dev flow, and it is the one that was hashed.
    const { codeHash } = repository.createForEmail.mock.calls[0]![0] as { codeHash: string };
    expect(await bcrypt.compare(result.devOtp!, codeHash)).toBe(true);
  });
});

describe('verifyEmailCodeFor', () => {
  const live = async (code: string, over: Record<string, unknown> = {}) => ({
    id: 'otp_1',
    userId: 'usr_1',
    email: 'asha@work.co',
    purpose: 'CONTACT_VERIFY',
    codeHash: await bcrypt.hash(code, 4),
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    verifiedAt: null,
    createdAt: new Date(),
    ...over,
  });

  it('answers the user id the code was issued for and clears the slate', async () => {
    repository.findLatestUnverifiedByEmail.mockResolvedValue(await live('123456'));
    await expect(verifyEmailCodeFor('Asha@Work.co', '123456', CONTACT_VERIFY_PURPOSE)).resolves.toBe('usr_1');
    expect(repository.findLatestUnverifiedByEmail).toHaveBeenCalledWith('asha@work.co', 'CONTACT_VERIFY');
    expect(repository.markVerified).toHaveBeenCalledWith('otp_1');
    expect(security.clearOtpFailures).toHaveBeenCalledWith('asha@work.co');
  });

  it('a wrong guess counts against the address and answers OTP_INVALID', async () => {
    repository.findLatestUnverifiedByEmail.mockResolvedValue(await live('123456'));
    await expect(verifyEmailCodeFor('asha@work.co', '000000', CONTACT_VERIFY_PURPOSE)).rejects.toMatchObject({ statusCode: 401, reason: 'OTP_INVALID' });
    expect(repository.incrementAttempts).toHaveBeenCalledWith('otp_1');
    expect(security.registerOtpFailure).toHaveBeenCalledWith('asha@work.co');
    expect(repository.markVerified).not.toHaveBeenCalled();
  });

  it('no live code is OTP_EXPIRED; a spent one is OTP_ATTEMPTS_EXCEEDED; a lock is 429', async () => {
    repository.findLatestUnverifiedByEmail.mockResolvedValue(null);
    await expect(verifyEmailCodeFor('asha@work.co', '123456', CONTACT_VERIFY_PURPOSE)).rejects.toMatchObject({ reason: 'OTP_EXPIRED' });

    repository.findLatestUnverifiedByEmail.mockResolvedValue(await live('123456', { attempts: 5 }));
    await expect(verifyEmailCodeFor('asha@work.co', '123456', CONTACT_VERIFY_PURPOSE)).rejects.toMatchObject({ reason: 'OTP_ATTEMPTS_EXCEEDED' });

    repository.findLatestUnverifiedByEmail.mockResolvedValue(await live('123456'));
    security.registerOtpFailure.mockResolvedValue({ locked: true, lockedUntil: new Date(), retryAfterSeconds: 900 });
    await expect(verifyEmailCodeFor('asha@work.co', '000000', CONTACT_VERIFY_PURPOSE)).rejects.toMatchObject({ statusCode: 429, reason: 'OTP_LOCKED' });
  });
});

describe('the reads and the sweep', () => {
  it('expireOutstandingOtpsForUser sweeps every live code the account holds', async () => {
    await expireOutstandingOtpsForUser('usr_1');
    expect(repository.expireOutstandingForUser).toHaveBeenCalledWith('usr_1');
  });

  it('hasProvenEmail asks with the normalised address', async () => {
    repository.hasVerifiedEmail.mockResolvedValue(true);
    await expect(hasProvenEmail('usr_1', ' Asha@ADX.co')).resolves.toBe(true);
    expect(repository.hasVerifiedEmail).toHaveBeenCalledWith('usr_1', 'asha@adx.co');
  });
});
