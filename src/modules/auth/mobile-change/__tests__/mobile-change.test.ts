import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 07, wave 5 → Lot F (Q18) — moving the number the account signs in with,
 * with the old number's consent first.
 *
 * What is pinned: the number must be free and must not be the one already on
 * the account; a withdrawal in flight blocks the change at every step; start
 * codes the CURRENT number under CHANGE_MOBILE_OLD; confirm-old checks that
 * code, remembers the consent for fifteen minutes and codes the NEW number
 * under CHANGE_MOBILE; verify refuses without a standing consent for that
 * exact number, and on a good code swaps the column, revokes every session
 * (refresh tokens and the access tokens in flight), audits
 * USER_MOBILE_CHANGED with the diff and tells the person.
 */

const { repository, otp, tokens, notifications, audit, redis } = vi.hoisted(() => ({
  repository: {
    findUser: vi.fn(),
    findUserByMobile: vi.fn(),
    countWithdrawalsInFlight: vi.fn(),
    changeMobile: vi.fn(),
  },
  otp: {
    normalizeMobile: vi.fn((value: string) => {
      const digits = value.replace(/\D/g, '');
      return digits.length === 10 ? `+91${digits}` : digits.length === 12 ? `+${digits}` : value;
    }),
    sendOtpToNumberForUser: vi.fn(),
    verifyOtp: vi.fn(),
    /* K-B1: the post-swap work expires every live code the account holds. */
    expireOutstandingOtpsForUser: vi.fn(),
  },
  tokens: { revokeSessions: vi.fn(), revokeAllRefreshTokens: vi.fn() },
  notifications: { createNotification: vi.fn(), notify: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn((before: Record<string, unknown>, after: Record<string, unknown>) => ({ mobile: { before: before['mobile'], after: after['mobile'] } })) },
  redis: { store: new Map<string, string>(), redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() } },
}));

vi.mock('../prisma-mobile-change.repository', () => ({ prismaMobileChangeRepository: repository }));
vi.mock('../../otp/otp.service', () => otp);
vi.mock('../../tokens/tokens.service', () => tokens);
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../../shared/cache', () => ({ redis: redis.redis }));

import { CONFIRM_OLD_TTL_SECONDS, completeMobileChange, confirmOldMobile, maskNewMobile, startMobileChange, verifyMobileChange } from '../mobile-change.service';

const user = { id: 'usr_1', mobile: '+919999999999' };
const NEW = '+919845012210';

beforeEach(() => {
  vi.clearAllMocks();
  redis.store.clear();
  redis.redis.set.mockImplementation(async (key: string, value: string) => {
    redis.store.set(key, value);
    return 'OK';
  });
  redis.redis.get.mockImplementation(async (key: string) => redis.store.get(key) ?? null);
  redis.redis.del.mockImplementation(async (key: string) => (redis.store.delete(key) ? 1 : 0));
  repository.findUser.mockResolvedValue(user);
  repository.findUserByMobile.mockResolvedValue(null);
  repository.countWithdrawalsInFlight.mockResolvedValue(0);
  repository.changeMobile.mockImplementation(async (_id: string, mobile: string) => ({ ...user, mobile }));
  otp.sendOtpToNumberForUser.mockResolvedValue({ resendAfterSeconds: 60, sendsRemaining: 2, expiresInSeconds: 600 });
  otp.verifyOtp.mockResolvedValue('usr_1');
  notifications.notify.mockResolvedValue({ notificationId: 'ntf_1', templateKey: 'mobile-changed', deliveries: [{ channel: 'SMS', deliveryId: 'dlv_1' }] });
});

describe('start — the new number is checked, the CURRENT number is coded', () => {
  it('validates the new number and sends the first code to the number the account has now', async () => {
    const result = await startMobileChange('usr_1', '+91 98450 12210');
    expect(otp.sendOtpToNumberForUser).toHaveBeenCalledWith('usr_1', '+919999999999', 'CHANGE_MOBILE_OLD');
    expect(otp.sendOtpToNumberForUser).not.toHaveBeenCalledWith('usr_1', NEW, expect.anything());
    expect(result).toMatchObject({ sentTo: 'CURRENT', expiresInSeconds: 600 });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'MOBILE_CHANGE_STARTED',
      expect.objectContaining({ targetType: 'User', targetId: 'usr_1', metadata: expect.objectContaining({ to: NEW }) }),
    );
  });

  it('refuses the number already on the account, and one somebody else has', async () => {
    await expect(startMobileChange('usr_1', '+919999999999')).rejects.toMatchObject({ statusCode: 409 });
    repository.findUserByMobile.mockResolvedValueOnce({ id: 'usr_2' });
    await expect(startMobileChange('usr_1', NEW)).rejects.toMatchObject({ statusCode: 409 });
    expect(otp.sendOtpToNumberForUser).not.toHaveBeenCalled();
  });

  it('refuses while a withdrawal is in flight, and asks about exactly the three unpaid states', async () => {
    repository.countWithdrawalsInFlight.mockResolvedValueOnce(1);
    await expect(startMobileChange('usr_1', NEW)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.countWithdrawalsInFlight).toHaveBeenCalledWith('usr_1', ['REQUESTED', 'APPROVED', 'PROCESSING']);
    expect(otp.sendOtpToNumberForUser).not.toHaveBeenCalled();
  });

  it('a fresh start withdraws any consent already given', async () => {
    redis.store.set('auth:mobile-change:usr_1', NEW);
    await startMobileChange('usr_1', '+919845000000');
    expect(redis.store.has('auth:mobile-change:usr_1')).toBe(false);
  });
});

describe('confirm-old — the old number consents, the NEW number is coded', () => {
  it('checks the old number code, remembers the consent for fifteen minutes, sends the second code to the new number', async () => {
    const result = await confirmOldMobile('usr_1', NEW, '123456');
    expect(otp.verifyOtp).toHaveBeenCalledWith('+919999999999', '123456', 'CHANGE_MOBILE_OLD');
    expect(otp.sendOtpToNumberForUser).toHaveBeenCalledWith('usr_1', NEW, 'CHANGE_MOBILE');
    expect(redis.redis.set).toHaveBeenCalledWith('auth:mobile-change:usr_1', NEW, 'EX', CONFIRM_OLD_TTL_SECONDS);
    expect(CONFIRM_OLD_TTL_SECONDS).toBe(15 * 60);
    expect(result).toMatchObject({ sentTo: 'NEW', confirmWithinSeconds: 900 });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'MOBILE_CHANGE_OLD_CONFIRMED', expect.objectContaining({ targetType: 'User' }));
  });

  it('a wrong old-number code sends nothing to the new number and records no consent', async () => {
    otp.verifyOtp.mockRejectedValueOnce(Object.assign(new Error('bad code'), { statusCode: 401 }));
    await expect(confirmOldMobile('usr_1', NEW, '000000')).rejects.toMatchObject({ statusCode: 401 });
    expect(otp.sendOtpToNumberForUser).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });

  it("a code that proves somebody else's number is refused", async () => {
    otp.verifyOtp.mockResolvedValueOnce('usr_other');
    await expect(confirmOldMobile('usr_1', NEW, '123456')).rejects.toMatchObject({ statusCode: 401 });
    expect(redis.store.size).toBe(0);
  });

  it('re-checks the guards: a number taken in the meantime, or money in flight', async () => {
    repository.findUserByMobile.mockResolvedValueOnce({ id: 'usr_2' });
    await expect(confirmOldMobile('usr_1', NEW, '123456')).rejects.toMatchObject({ statusCode: 409 });
    repository.countWithdrawalsInFlight.mockResolvedValueOnce(1);
    await expect(confirmOldMobile('usr_1', NEW, '123456')).rejects.toMatchObject({ statusCode: 409 });
    expect(otp.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('verify — only after the old number consented, for that number', () => {
  it('refuses without a standing consent, and never checks the code', async () => {
    await expect(verifyMobileChange('usr_1', NEW, '654321')).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'OLD_NUMBER_NOT_CONFIRMED' },
    });
    expect(otp.verifyOtp).not.toHaveBeenCalled();
    expect(repository.changeMobile).not.toHaveBeenCalled();
  });

  it('refuses when the consent was for a different number', async () => {
    redis.store.set('auth:mobile-change:usr_1', '+919845000000');
    await expect(verifyMobileChange('usr_1', NEW, '654321')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.changeMobile).not.toHaveBeenCalled();
  });

  it('refuses when Redis cannot answer — the consent fails closed', async () => {
    redis.redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(verifyMobileChange('usr_1', NEW, '654321')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('swaps the number, revokes every session, audits the diff and tells the person', async () => {
    await confirmOldMobile('usr_1', NEW, '123456');
    vi.clearAllMocks();
    otp.verifyOtp.mockResolvedValue('usr_1');
    repository.findUser.mockResolvedValue(user);
    repository.findUserByMobile.mockResolvedValue(null);
    repository.countWithdrawalsInFlight.mockResolvedValue(0);
    repository.changeMobile.mockImplementation(async (_id: string, mobile: string) => ({ ...user, mobile }));
    redis.redis.get.mockImplementation(async (key: string) => redis.store.get(key) ?? null);
    redis.redis.del.mockImplementation(async (key: string) => (redis.store.delete(key) ? 1 : 0));

    const result = await verifyMobileChange('usr_1', NEW, '654321');
    expect(otp.verifyOtp).toHaveBeenCalledWith(NEW, '654321', 'CHANGE_MOBILE');
    expect(repository.changeMobile).toHaveBeenCalledWith('usr_1', NEW);
    // Every session: the refresh tokens AND the access tokens still in flight.
    expect(tokens.revokeSessions).toHaveBeenCalledWith('usr_1', 'MOBILE_CHANGED');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_MOBILE_CHANGED',
      expect.objectContaining({
        targetType: 'User',
        targetId: 'usr_1',
        module: 'auth',
        diff: { mobile: { before: '+919999999999', after: NEW } },
      }),
    );
    // E9: one dispatch — the in-app row on the account, and the MOBILE_CHANGED
    // SMS (kind CHANGE_MOBILE) to the OLD number, which is where a person who
    // did not do this finds out. The new number is masked to its last two digits.
    expect(notifications.notify).toHaveBeenCalledWith(
      'MOBILE_CHANGED',
      'usr_1',
      { newMasked: '+91 XXXXX ***10', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      expect.objectContaining({
        type: 'SYSTEM',
        recipient: { mobile: '+919999999999' },
        immediate: true,
        inApp: expect.objectContaining({ type: 'SYSTEM', title: 'Your sign-in number changed', message: expect.stringContaining('If this was not you') }),
      }),
    );
    expect(result).toEqual({ mobile: NEW, previousMobile: '+919999999999', sessionsRevoked: true });
    // The consent is spent.
    expect(redis.store.has('auth:mobile-change:usr_1')).toBe(false);
  });

  it('never blocks the swap on a failed send: a dispatcher that throws still leaves the number changed and the sessions gone', async () => {
    await confirmOldMobile('usr_1', NEW, '123456');
    notifications.notify.mockRejectedValue(new Error('rail down'));
    const result = await verifyMobileChange('usr_1', NEW, '654321');
    expect(repository.changeMobile).toHaveBeenCalledWith('usr_1', NEW);
    expect(tokens.revokeSessions).toHaveBeenCalledWith('usr_1', 'MOBILE_CHANGED');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'USER_MOBILE_CHANGED', expect.anything());
    expect(result).toEqual({ mobile: NEW, previousMobile: '+919999999999', sessionsRevoked: true });
  });

  it('masks the new number to +91 XXXXX ***NN for the old number’s SMS', () => {
    expect(maskNewMobile('+919845012210')).toBe('+91 XXXXX ***10');
    expect(maskNewMobile('9845012299')).toBe('+91 XXXXX ***99');
  });

  it('re-checks both guards under a standing consent, because minutes pass between the calls', async () => {
    redis.store.set('auth:mobile-change:usr_1', NEW);
    repository.findUserByMobile.mockResolvedValueOnce({ id: 'usr_2' });
    await expect(verifyMobileChange('usr_1', NEW, '654321')).rejects.toMatchObject({ statusCode: 409 });

    repository.countWithdrawalsInFlight.mockResolvedValueOnce(1);
    await expect(verifyMobileChange('usr_1', NEW, '654321')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.changeMobile).not.toHaveBeenCalled();
  });

  it('a wrong new-number code changes nothing and keeps the consent for another try', async () => {
    redis.store.set('auth:mobile-change:usr_1', NEW);
    otp.verifyOtp.mockRejectedValueOnce(Object.assign(new Error('bad code'), { statusCode: 401 }));
    await expect(verifyMobileChange('usr_1', NEW, '000000')).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.changeMobile).not.toHaveBeenCalled();
    expect(tokens.revokeSessions).not.toHaveBeenCalled();
    expect(redis.store.get('auth:mobile-change:usr_1')).toBe(NEW);
  });
});

/* K-B1: the post-swap work, shared with the contacts desk's make-primary. */
describe('completeMobileChange', () => {
  it('revokes every session, expires every live code, audits the pair under the caller’s action and tells the old number', async () => {
    otp.expireOutstandingOtpsForUser.mockResolvedValue(undefined);
    await completeMobileChange('usr_1', '+919999999999', NEW, { action: 'USER_PRIMARY_CHANGED', module: 'users', metadata: { reason: 'lost the SIM', changedBy: 'adm_1' } });

    expect(tokens.revokeSessions).toHaveBeenCalledWith('usr_1', 'MOBILE_CHANGED');
    expect(otp.expireOutstandingOtpsForUser).toHaveBeenCalledWith('usr_1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_PRIMARY_CHANGED',
      expect.objectContaining({
        module: 'users',
        targetType: 'User',
        targetId: 'usr_1',
        diff: { mobile: { before: '+919999999999', after: NEW } },
        metadata: { from: '+919999999999', to: NEW, reason: 'lost the SIM', changedBy: 'adm_1' },
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      'MOBILE_CHANGED',
      'usr_1',
      expect.objectContaining({ newMasked: '+91 XXXXX ***10' }),
      expect.objectContaining({ recipient: { mobile: '+919999999999' } }),
    );
  });

  it('the self-service verify runs through it, so the live codes on the old number go too', async () => {
    redis.store.set('auth:mobile-change:usr_1', NEW);
    otp.verifyOtp.mockResolvedValue('usr_1');
    repository.changeMobile.mockResolvedValue({ ...user, mobile: NEW });
    await verifyMobileChange('usr_1', NEW, '654321');
    expect(otp.expireOutstandingOtpsForUser).toHaveBeenCalledWith('usr_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'USER_MOBILE_CHANGED', expect.objectContaining({ module: 'auth' }));
  });

  it('a failed code expiry never blocks the swap’s other work', async () => {
    otp.expireOutstandingOtpsForUser.mockRejectedValue(new Error('db away'));
    await completeMobileChange('usr_1', '+919999999999', NEW, { action: 'X', module: 'users' });
    expect(audit.logActivity).toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalled();
  });
});
