import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q-B: the dev-only admin sign-in (owner's item 11).
 *
 * `DEV_LOGIN_MOBILES` takes `<mobile>` or `<mobile>:<ROLE>`. An entry
 * carrying `:ADMIN` mints an ADMIN only when BOTH `NODE_ENV !== 'production'`
 * AND `DEV_ADMIN_LOGIN=true`; missing either, the entry is refused with a
 * logged reason and the number takes the ordinary register-or-login path
 * (a roleless user — never an admin, never even the agent default). A mint
 * is audited `DEV_ADMIN_LOGIN_USED`. The second factor is untouched: the
 * minted admin carries an email so the console's 2FA challenge has a
 * channel left after the mobile door has spent SMS.
 */

const { env, repository, security, sms, audit, ports, logger } = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'development' as string,
    DEV_LOGIN_MOBILES: '',
    DEV_ADMIN_LOGIN: false,
  },
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
  audit: { logActivity: vi.fn() },
  ports: { mobileWasErased: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../config/env', () => ({ env }));
vi.mock('../prisma-otp.repository', () => ({ prismaOtpRepository: repository }));
vi.mock('../otp-security', () => security);
vi.mock('../../../../shared/sms', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../../shared/sms')>()), ...sms }));
vi.mock('../../../../shared/email', () => ({ sendViaResend: vi.fn() }));
vi.mock('../../../../shared/logging', () => ({ logger }));
// QR-4: the person's own id is minted at creation; the series is not under test here.
vi.mock('../../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'ADX-1709-2601') }));
vi.mock('../../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })) }));
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../auth.ports', () => ports);

import { parseDevLoginAllowlist, sendOtp } from '../otp.service';

const ADMIN_MOBILE = '+919000000099';
const AGENT_MOBILE = '+919000000098';

beforeEach(() => {
  vi.clearAllMocks();
  env.NODE_ENV = 'development';
  env.DEV_ADMIN_LOGIN = false;
  env.DEV_LOGIN_MOBILES = '9000000098,9000000099:ADMIN';
  repository.findUserByMobile.mockResolvedValue(null);
  repository.createUnregisteredUser.mockResolvedValue({ id: 'usr_ghost' });
  repository.createDevLoginUser.mockResolvedValue({ id: 'usr_dev' });
  repository.expireOutstandingByMobile.mockResolvedValue(undefined);
  repository.createForMobile.mockResolvedValue({});
  security.assertOtpNotLocked.mockResolvedValue(undefined);
  security.reserveOtpSend.mockResolvedValue({ resendAfterSeconds: 30, sendsRemaining: 2 });
  sms.sendSms.mockResolvedValue(undefined);
  audit.logActivity.mockResolvedValue(undefined);
  ports.mobileWasErased.mockResolvedValue(false);
});

describe('parseDevLoginAllowlist', () => {
  it('reads <mobile> as the agent default and <mobile>:<ROLE> as the named role, normalised', () => {
    env.DEV_LOGIN_MOBILES = ' 9000000098 , +919000000099:ADMIN ,9000000097:publisher';
    expect(parseDevLoginAllowlist()).toEqual(
      new Map([
        [AGENT_MOBILE, 'AGENT_PUBLISHER'],
        [ADMIN_MOBILE, 'ADMIN'],
        ['+919000000097', 'PUBLISHER'],
      ]),
    );
  });

  it('drops an entry naming a role that is not seeded, with a logged reason', () => {
    env.DEV_LOGIN_MOBILES = '9000000097:ROOT';
    expect(parseDevLoginAllowlist().size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DEV_LOGIN_MOBILES'), expect.objectContaining({ role: 'ROOT' }));
  });
});

describe('sendOtp with a :ADMIN allowlist entry', () => {
  it('refuses in production — a roleless user, no mint, no audit, and the reason logged', async () => {
    env.NODE_ENV = 'production';
    env.DEV_ADMIN_LOGIN = true;

    await sendOtp(ADMIN_MOBILE, 'LOGIN');

    expect(repository.createDevLoginUser).not.toHaveBeenCalled();
    expect(repository.createUnregisteredUser).toHaveBeenCalledWith(ADMIN_MOBILE, 'ADX-1709-2601');
    expect(audit.logActivity).not.toHaveBeenCalledWith(expect.anything(), 'DEV_ADMIN_LOGIN_USED', expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.objectContaining({ mobile: ADMIN_MOBILE, reason: 'NODE_ENV_PRODUCTION' }));
  });

  it('refuses with the flag off — the entry buys nothing, not even the agent default', async () => {
    env.DEV_ADMIN_LOGIN = false;

    await sendOtp(ADMIN_MOBILE, 'LOGIN');

    expect(repository.createDevLoginUser).not.toHaveBeenCalled();
    expect(repository.createUnregisteredUser).toHaveBeenCalledWith(ADMIN_MOBILE, 'ADX-1709-2601');
    expect(audit.logActivity).not.toHaveBeenCalledWith(expect.anything(), 'DEV_ADMIN_LOGIN_USED', expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.objectContaining({ mobile: ADMIN_MOBILE, reason: 'DEV_ADMIN_LOGIN_OFF' }));
  });

  it('mints an ADMIN when both guards pass, and audits DEV_ADMIN_LOGIN_USED on the new account', async () => {
    env.DEV_ADMIN_LOGIN = true;

    const result = await sendOtp(ADMIN_MOBILE, 'LOGIN');

    expect(repository.createDevLoginUser).toHaveBeenCalledWith(ADMIN_MOBILE, 'ADMIN', 'ADX-1709-2601');
    expect(repository.createUnregisteredUser).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_dev',
      'DEV_ADMIN_LOGIN_USED',
      expect.objectContaining({ module: 'auth', targetType: 'User', targetId: 'usr_dev', metadata: expect.objectContaining({ mobile: ADMIN_MOBILE }) }),
    );
    // The code still goes out — the second factor is the console's, untouched.
    expect(sms.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: ADMIN_MOBILE, kind: 'LOGIN_OTP' }));
    expect(result.devOtp).toMatch(/^\d{6}$/);
  });

  it('a plain entry still self-provisions the agent default, flag or no flag, and is not audited as an admin mint', async () => {
    await sendOtp(AGENT_MOBILE, 'LOGIN');

    expect(repository.createDevLoginUser).toHaveBeenCalledWith(AGENT_MOBILE, 'AGENT_PUBLISHER', 'ADX-1709-2601');
    expect(audit.logActivity).not.toHaveBeenCalledWith(expect.anything(), 'DEV_ADMIN_LOGIN_USED', expect.anything());
  });

  it('a known number never re-mints: the allowlist only opens the door once', async () => {
    env.DEV_ADMIN_LOGIN = true;
    repository.findUserByMobile.mockResolvedValue({ id: 'usr_existing' });

    await sendOtp(ADMIN_MOBILE, 'LOGIN');

    expect(repository.createDevLoginUser).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});
