import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Registering again on an erased number — Lot A (Q60).
 *
 * The decision: an erased person is entitled to come back, so the tombstone
 * never refuses a sign-up. What it does is put one activity row beside the new
 * account, which is what support needs when the same person rings about
 * history they can no longer see.
 */

const { repository, security, sms, email, audit, ports } = vi.hoisted(() => ({
  repository: {
    findUserByMobile: vi.fn(),
    createUnregisteredUser: vi.fn(),
    createPublisherUser: vi.fn(),
    createDevLoginUser: vi.fn(),
    expireOutstandingByMobile: vi.fn(),
    createForMobile: vi.fn(),
  },
  security: {
    OtpError: class OtpError extends Error {},
    assertOtpNotLocked: vi.fn(),
    clearOtpFailures: vi.fn(),
    registerOtpFailure: vi.fn(),
    reserveOtpSend: vi.fn(),
  },
  sms: { sendSms: vi.fn() },
  email: { sendViaResend: vi.fn() },
  audit: { logActivity: vi.fn() },
  ports: { mobileWasErased: vi.fn() },
}));

vi.mock('../prisma-otp.repository', () => ({ prismaOtpRepository: repository }));
vi.mock('../otp-security', () => security);
// Lot E: the login OTP is a direct send by kind; the sender's siblings stay real.
vi.mock('../../../../shared/sms', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../../shared/sms')>()), ...sms }));
vi.mock('../../../../shared/email', () => email);
vi.mock('../../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })) }));
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../auth.ports', () => ports);

import { sendOtp } from '../otp.service';

/* Not one of DEV_LOGIN_MOBILES, which takes a different creation path. */
const MOBILE = '+919000000042';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findUserByMobile.mockResolvedValue(null);
  repository.createUnregisteredUser.mockResolvedValue({ id: 'usr_new' });
  repository.createDevLoginUser.mockResolvedValue({ id: 'usr_new' });
  repository.expireOutstandingByMobile.mockResolvedValue(undefined);
  repository.createForMobile.mockResolvedValue({});
  security.assertOtpNotLocked.mockResolvedValue(undefined);
  security.reserveOtpSend.mockResolvedValue({ resendAfterSeconds: 30, sendsRemaining: 2 });
  sms.sendSms.mockResolvedValue(undefined);
  audit.logActivity.mockResolvedValue(undefined);
  ports.mobileWasErased.mockResolvedValue(false);
});

describe('sendOtp on an erased number', () => {
  it('still registers, and marks the new account', async () => {
    ports.mobileWasErased.mockResolvedValue(true);

    const result = await sendOtp(MOBILE, 'LOGIN');

    expect(repository.createUnregisteredUser).toHaveBeenCalledWith(MOBILE);
    expect(sms.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: MOBILE, kind: 'LOGIN_OTP' }));
    expect(result.expiresInSeconds).toBe(600);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_new',
      'REREGISTERED_AFTER_ERASURE',
      expect.objectContaining({ targetType: 'User', targetId: 'usr_new', module: 'auth' }),
    );
  });

  it('writes nothing when the number was never erased', async () => {
    await sendOtp(MOBILE, 'LOGIN');
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('asks nothing for a number that already has an account', async () => {
    repository.findUserByMobile.mockResolvedValue({ id: 'usr_known' });
    await sendOtp(MOBILE, 'LOGIN');
    expect(ports.mobileWasErased).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('does not fail the send when the tombstone cannot be read', async () => {
    ports.mobileWasErased.mockRejectedValue(new Error('database unreachable'));
    await expect(sendOtp(MOBILE, 'LOGIN')).resolves.toMatchObject({ expiresInSeconds: 600 });
    expect(sms.sendSms).toHaveBeenCalled();
  });
});
