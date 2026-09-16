import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot K2 — the authenticator app as an admin's second factor.
 *
 * What is pinned: enrol keeps the secret in Redis and out of the row until
 * the first code confirms it; confirm seals the secret, stamps the
 * enrolment and hands ten recovery codes back once; a sign-in with the app
 * passes and the same code is refused a second time (the replay guard); a
 * wrong code counts against the very lock the SMS path uses; a recovery
 * code spends itself, warns at two or fewer, and is refused twice; disable
 * and regenerate need a valid code; the policy's required state marks the
 * session must-enrol, and the sms-off policy lists AUTHENTICATOR alone;
 * the status read; and that the secret is never returned after enrolment.
 */
const { repository, otp, otpSecurity, notifications, audit, settings, fakeRedis } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const fakeRedis = {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && store.has(key)) return null;
      store.set(key, String(value));
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const key of keys) if (store.delete(key)) n += 1;
      return n;
    }),
    ttl: vi.fn(async () => 60),
    incr: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
  };
  return {
    fakeRedis,
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
      setAuthenticator: vi.fn(),
      clearAuthenticator: vi.fn(),
      replaceRecoveryCodes: vi.fn(),
      findUnusedRecoveryCodes: vi.fn(),
      spendRecoveryCode: vi.fn(),
      countUnusedRecoveryCodes: vi.fn(),
      countUnusedRecoveryCodesFor: vi.fn(),
    },
    otp: { sendOtp: vi.fn(), verifyOtp: vi.fn(), normalizeMobile: vi.fn((m: string) => m) },
    otpSecurity: {
      assertOtpNotLocked: vi.fn(),
      registerOtpFailure: vi.fn(),
      clearOtpFailures: vi.fn(),
      reserveOtpSend: vi.fn(),
    },
    notifications: { notify: vi.fn(), createNotification: vi.fn() },
    audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
    settings: { auth: { adminTwoFactor: { authenticatorRequired: false, smsAllowedWhenEnrolled: true } } },
  };
});

vi.mock('../prisma-two-factor.repository', () => ({ prismaTwoFactorRepository: repository }));
vi.mock('../../otp/otp.service', () => otp);
vi.mock('../../otp/otp-security', async (importActual) => ({
  ...(await importActual<typeof import('../../otp/otp-security')>()),
  ...otpSecurity,
}));
vi.mock('../../../notifications', () => notifications);
vi.mock('../../../../shared/audit', () => audit);
vi.mock('../../../../shared/cache', () => ({ redis: fakeRedis }));
vi.mock('../../../app-config', () => ({ getPlatformSettings: vi.fn(async () => settings) }));

import bcrypt from 'bcryptjs';
import {
  RECOVERY_CODE_COUNT,
  TOTP_PENDING_TTL_SECONDS,
  authenticatorStatus,
  clearAuthenticator,
  confirmEnrolment,
  disableAuthenticator,
  generateRecoveryCode,
  mustEnrolAuthenticator,
  regenerateRecoveryCodes,
  spendRecoveryCode,
  startEnrolment,
  verifyAppCode,
} from '../authenticator.service';
import { availableMethods, issueChallenge, issueChallengeAfterMobileOtp, readChallengeClaims, sendTwoFactorCode, verifyTwoFactorCode } from '../two-factor.service';
import { openSecret, totp } from '../totp';
import { CODE_ALPHABET, TWO_FACTOR_METHODS } from '../two-factor.schema';

const NOW = new Date('2026-09-14T10:00:00Z');

const admin = (over: Record<string, unknown> = {}) => ({
  id: 'adm_1',
  mobile: '+919845012210',
  email: 'asha.rao@adx.co',
  isActive: true,
  emailOtpFallbackCount: 0,
  emailOtpFallbackResetAt: null,
  totpSecretEnc: null,
  totpEnrolledAt: null,
  roles: [{ role: 'ADMIN' }],
  ...over,
});

/** Runs an enrolment through and answers the enrolled user row and the codes, as the database would hold them. */
async function enrol() {
  repository.findUser.mockResolvedValue(admin());
  const start = await startEnrolment('adm_1');
  const done = await confirmEnrolment('adm_1', totp(start.secret));
  const sealed = repository.setAuthenticator.mock.calls[0]![1].totpSecretEnc as string;
  const hashes = repository.replaceRecoveryCodes.mock.calls[0]![1] as string[];
  const enrolled = admin({ totpSecretEnc: sealed, totpEnrolledAt: done.enrolledAt });
  repository.findUser.mockResolvedValue(enrolled);
  repository.findUnusedRecoveryCodes.mockResolvedValue(hashes.map((codeHash, i) => ({ id: `rc_${i}`, userId: 'adm_1', codeHash, usedAt: null, createdAt: NOW })));
  forgetUsedSteps();
  return { start, done, enrolled, secret: start.secret };
}

/** M-B: the replay guard is one SET NX key per accepted step; the tests sign in at the step that enrolled. */
function forgetUsedSteps() {
  for (const key of [...fakeRedis.store.keys()]) if (key.startsWith('auth:totp:used:adm_1:')) fakeRedis.store.delete(key);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeRedis.store.clear();
  settings.auth.adminTwoFactor = { authenticatorRequired: false, smsAllowedWhenEnrolled: true };
  repository.findUser.mockResolvedValue(admin());
  repository.stampTwoFactorRequired.mockResolvedValue({});
  repository.setAuthenticator.mockResolvedValue({});
  repository.clearAuthenticator.mockResolvedValue({});
  repository.replaceRecoveryCodes.mockResolvedValue(undefined);
  repository.findUnusedRecoveryCodes.mockResolvedValue([]);
  repository.spendRecoveryCode.mockResolvedValue(true);
  repository.countUnusedRecoveryCodes.mockResolvedValue(10);
  repository.resetEmailFallback.mockResolvedValue({});
  repository.findLatestTwoFactorOtp.mockResolvedValue(null);
  otpSecurity.assertOtpNotLocked.mockResolvedValue(undefined);
  otpSecurity.registerOtpFailure.mockResolvedValue({ locked: false, attemptsRemaining: 4 });
  otpSecurity.clearOtpFailures.mockResolvedValue(undefined);
  notifications.createNotification.mockResolvedValue({ id: 'ntf_1' });
});

describe('enrolment', () => {
  it('keeps the pending secret in Redis for ten minutes and never writes the row until confirmed', async () => {
    const start = await startEnrolment('adm_1');
    expect(start.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.otpauthUri).toContain('otpauth://totp/ADX%3Aasha.rao%40adx.co?');
    expect(start.otpauthUri).toContain(`secret=${start.secret}`);
    expect(start.qrSvg.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(start.expiresInSeconds).toBe(TOTP_PENDING_TTL_SECONDS);
    expect(fakeRedis.set).toHaveBeenCalledWith('auth:totp:pending:adm_1', start.secret, 'EX', TOTP_PENDING_TTL_SECONDS);
    expect(repository.setAuthenticator).not.toHaveBeenCalled();

    // A second enrol replaces the pending one.
    const again = await startEnrolment('adm_1');
    expect(again.secret).not.toBe(start.secret);
    expect(fakeRedis.store.get('auth:totp:pending:adm_1')).toBe(again.secret);
  });

  it('refuses a second enrolment while one stands — disable first', async () => {
    repository.findUser.mockResolvedValue(admin({ totpSecretEnc: 'x', totpEnrolledAt: NOW }));
    await expect(startEnrolment('adm_1')).rejects.toMatchObject({ statusCode: 409, code: 'TOTP_ALREADY_ENROLLED' });
  });

  it('confirm seals the secret, stamps the enrolment, issues ten recovery codes once, and tells the person', async () => {
    const { start, done, secret } = await enrol();
    const written = repository.setAuthenticator.mock.calls[0]![1] as { totpSecretEnc: string; totpEnrolledAt: Date };
    expect(written.totpSecretEnc).not.toContain(secret);
    expect(openSecret(written.totpSecretEnc)).toBe(secret);
    expect(written.totpEnrolledAt).toBeInstanceOf(Date);
    expect(done.enrolledAt).toEqual(written.totpEnrolledAt);

    expect(done.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of done.recoveryCodes) expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}$`));
    expect(new Set(done.recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
    const hashes = repository.replaceRecoveryCodes.mock.calls[0]![1] as string[];
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(await bcrypt.compare(done.recoveryCodes[0]!.replace('-', ''), hashes[0]!)).toBe(true);

    // The pending secret is gone, and the answer never carries the secret again.
    expect(fakeRedis.store.has('auth:totp:pending:adm_1')).toBe(false);
    expect(JSON.stringify(done)).not.toContain(start.secret);
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'adm_1', type: 'SYSTEM', title: 'Authenticator app set up' }));
  });

  it('confirm refuses a wrong code and an expired set-up', async () => {
    const start = await startEnrolment('adm_1');
    await expect(confirmEnrolment('adm_1', '000000')).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.setAuthenticator).not.toHaveBeenCalled();
    fakeRedis.store.clear();
    await expect(confirmEnrolment('adm_1', totp(start.secret))).rejects.toMatchObject({ statusCode: 409, code: 'TOTP_NOT_ENROLLED' });
  });
});

describe('signing in with the app', () => {
  const challengeFor = async () => (await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' })).challengeToken;

  it('lists AUTHENTICATOR first once enrolled, and /2fa/send answers the step without sending', async () => {
    expect(TWO_FACTOR_METHODS).toEqual(['AUTHENTICATOR', 'SMS', 'EMAIL']);
    expect(await availableMethods('adm_1', 'asha.rao@adx.co')).toEqual(['SMS', 'EMAIL']);
    await enrol();
    expect(await availableMethods('adm_1', 'asha.rao@adx.co')).toEqual(['AUTHENTICATOR', 'SMS', 'EMAIL']);
    const sent = await sendTwoFactorCode(await challengeFor(), 'AUTHENTICATOR');
    expect(sent).toEqual({ method: 'AUTHENTICATOR', expiresInSeconds: 30 });
    expect(otp.sendOtp).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('refuses AUTHENTICATOR on /2fa/send for an account with no enrolment', async () => {
    await expect(sendTwoFactorCode(await challengeFor(), 'AUTHENTICATOR')).rejects.toMatchObject({ statusCode: 409, code: 'TOTP_NOT_ENROLLED' });
  });

  it("enrol -> confirm -> sign-in with the app's code passes, clears the lock, earns the email backup back, and is refused a second time", async () => {
    const { secret } = await enrol();
    const code = totp(secret);
    const result = await verifyTwoFactorCode(await challengeFor(), code);
    expect(result).toEqual({ userId: 'adm_1', roles: ['ADMIN'], method: 'AUTHENTICATOR' });
    expect(otpSecurity.assertOtpNotLocked).toHaveBeenCalledWith('+919845012210');
    expect(otpSecurity.clearOtpFailures).toHaveBeenCalledWith('+919845012210');
    expect(repository.resetEmailFallback).toHaveBeenCalledWith('adm_1');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_PASSED', expect.objectContaining({ metadata: { method: 'AUTHENTICATOR' } }));

    // The replay guard: the same step's code is refused, and counted as a wrong guess.
    await expect(verifyTwoFactorCode(await challengeFor(), code)).rejects.toMatchObject({ statusCode: 401, message: expect.stringContaining('already used') });
    expect(otpSecurity.registerOtpFailure).toHaveBeenCalledWith('+919845012210');
    // M-B: the step is claimed atomically — SET NX on a key that names it, held 90 seconds.
    expect(fakeRedis.set).toHaveBeenCalledWith(expect.stringMatching(/^auth:totp:used:adm_1:\d+$/), '1', 'EX', 90, 'NX');
  });

  it('M-B: two requests carrying the same code at once give one sign-in, not two — the claim is atomic', async () => {
    const { enrolled, secret } = await enrol();
    const code = totp(secret);
    // Both requests read the code as valid; only one SET NX can win the step.
    const outcomes = await Promise.allSettled([verifyAppCode(enrolled as never, code), verifyAppCode(enrolled as never, code)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ statusCode: 401, reason: 'OTP_INVALID', message: expect.stringContaining('already used') });
    expect(otpSecurity.registerOtpFailure).toHaveBeenCalledTimes(1);
    // No read-then-write: the only Redis traffic for the step is the one claim per request.
    expect(fakeRedis.get.mock.calls.filter(([key]) => String(key).startsWith('auth:totp:used:'))).toHaveLength(0);
  });

  it('a wrong code is counted against the same limiter the SMS path uses, and a locked number is refused', async () => {
    const { enrolled, secret } = await enrol();
    await expect(verifyAppCode(enrolled as never, '000000')).rejects.toMatchObject({ statusCode: 401, reason: 'OTP_INVALID', details: { attemptsRemaining: 4 } });
    expect(otpSecurity.registerOtpFailure).toHaveBeenCalledWith('+919845012210');
    expect(audit.logActivity).not.toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_PASSED', expect.anything());

    otpSecurity.registerOtpFailure.mockResolvedValue({ locked: true, lockedUntil: '2026-09-14T10:15:00Z', retryAfterSeconds: 900 });
    await expect(verifyAppCode(enrolled as never, '000000')).rejects.toMatchObject({ statusCode: 429, reason: 'OTP_LOCKED', retryAfterSeconds: 900 });

    otpSecurity.assertOtpNotLocked.mockRejectedValue(Object.assign(new Error('locked'), { statusCode: 429 }));
    await expect(verifyAppCode(enrolled as never, totp(secret))).rejects.toMatchObject({ statusCode: 429 });
    await expect(verifyTwoFactorCode(await challengeFor(), '123456')).rejects.toMatchObject({ statusCode: 429 });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_FAILED', expect.anything());
  });

  it('a live SMS code still decides the channel — the app path is taken only when nothing was sent', async () => {
    await enrol();
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_1', purpose: 'TWO_FACTOR', attempts: 0, codeHash: 'x' });
    otp.verifyOtp.mockResolvedValue('adm_1');
    const result = await verifyTwoFactorCode(await challengeFor(), '123456');
    expect(result.method).toBe('SMS');
    expect(otp.verifyOtp).toHaveBeenCalledWith('+919845012210', '123456', 'TWO_FACTOR');
  });

  it('a recovery code spends itself, answers how many are left with a warning at two, and is refused twice', async () => {
    const { done } = await enrol();
    const [first] = done.recoveryCodes;
    repository.countUnusedRecoveryCodes.mockResolvedValue(9);
    const result = await verifyTwoFactorCode(await challengeFor(), ` ${first!.toLowerCase()} `);
    expect(result).toMatchObject({ method: 'RECOVERY_CODE', recoveryCodesLeft: 9, warning: null });
    expect(repository.spendRecoveryCode).toHaveBeenCalledWith('rc_0');
    expect(otpSecurity.clearOtpFailures).toHaveBeenCalledWith('+919845012210');

    // Spent: the row is gone from the unused set, so the same code is refused and counted.
    const rows = repository.findUnusedRecoveryCodes.mock.results[0]!.value as Promise<{ id: string }[]>;
    repository.findUnusedRecoveryCodes.mockResolvedValue((await rows).filter((row) => row.id !== 'rc_0'));
    await expect(verifyTwoFactorCode(await challengeFor(), first!)).rejects.toMatchObject({ statusCode: 401, reason: 'OTP_INVALID' });
    expect(otpSecurity.registerOtpFailure).toHaveBeenCalledWith('+919845012210');
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_FAILED', expect.objectContaining({ metadata: { reason: 'RECOVERY_OTP_INVALID' } }));

    // The warning at two or fewer.
    repository.countUnusedRecoveryCodes.mockResolvedValue(2);
    const low = await verifyTwoFactorCode(await challengeFor(), done.recoveryCodes[1]!);
    expect(low.recoveryCodesLeft).toBe(2);
    expect(low.warning).toContain('2 recovery codes left');
  });

  it('a race on the same recovery code gives one sign-in, not two', async () => {
    const { done, enrolled } = await enrol();
    repository.spendRecoveryCode.mockResolvedValue(false);
    await expect(spendRecoveryCode(enrolled as never, done.recoveryCodes[0]!)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('disable and regenerate', () => {
  it("disable needs the app's code or a recovery code; a wrong one leaves the enrolment standing", async () => {
    const { enrolled, secret } = await enrol();
    await expect(disableAuthenticator('adm_1', { code: '000000' })).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.clearAuthenticator).not.toHaveBeenCalled();
    await expect(disableAuthenticator('adm_1', {})).rejects.toMatchObject({ statusCode: 400 });

    const result = await disableAuthenticator('adm_1', { code: totp(secret) });
    expect(result).toEqual({ how: 'CODE' });
    expect(repository.clearAuthenticator).toHaveBeenCalledWith('adm_1');
    expect(repository.replaceRecoveryCodes).toHaveBeenLastCalledWith('adm_1', []);
    expect(fakeRedis.del).toHaveBeenCalledWith('auth:totp:pending:adm_1', ...[-1, 0, 1].map((d) => `auth:totp:used:adm_1:${Math.floor(Date.now() / 30000) + d}`));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Authenticator app removed' }));
    void enrolled;
  });

  it('disable takes a recovery code too — the phone may be the thing that was lost', async () => {
    const { done } = await enrol();
    const result = await disableAuthenticator('adm_1', { recoveryCode: done.recoveryCodes[3]! });
    expect(result).toEqual({ how: 'RECOVERY_CODE' });
    expect(repository.spendRecoveryCode).toHaveBeenCalledWith('rc_3');
    expect(repository.clearAuthenticator).toHaveBeenCalledWith('adm_1');
  });

  it('disable and regenerate are 409 with no enrolment', async () => {
    await expect(disableAuthenticator('adm_1', { code: '123456' })).rejects.toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
    await expect(regenerateRecoveryCodes('adm_1', '123456')).rejects.toMatchObject({ code: 'TOTP_NOT_ENROLLED' });
  });

  it('regenerate needs a valid code and replaces the ten', async () => {
    const { done, secret } = await enrol();
    await expect(regenerateRecoveryCodes('adm_1', '000000')).rejects.toMatchObject({ statusCode: 401 });
    forgetUsedSteps();
    const fresh = await regenerateRecoveryCodes('adm_1', totp(secret));
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toEqual(done.recoveryCodes);
    expect(repository.replaceRecoveryCodes).toHaveBeenCalledTimes(2);
  });

  it('the desk reset clears the columns, the codes and the Redis state, and says what it cleared', async () => {
    await enrol();
    repository.countUnusedRecoveryCodes.mockResolvedValue(7);
    await expect(clearAuthenticator('adm_1')).resolves.toEqual({ hadAuthenticator: true, recoveryCodesCleared: 7 });
    expect(repository.clearAuthenticator).toHaveBeenCalledWith('adm_1');
    expect(repository.replaceRecoveryCodes).toHaveBeenLastCalledWith('adm_1', []);
    repository.findUser.mockResolvedValue(admin());
    repository.countUnusedRecoveryCodes.mockResolvedValue(0);
    await expect(clearAuthenticator('adm_1')).resolves.toEqual({ hadAuthenticator: false, recoveryCodesCleared: 0 });
  });

  it('generates recovery codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 30; i += 1) expect(generateRecoveryCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  });
});

describe('the policy', () => {
  it('authenticatorRequired marks an un-enrolled admin must-enrol, never an enrolled one or a non-admin', async () => {
    expect(await mustEnrolAuthenticator(admin() as never, true)).toBe(false);
    settings.auth.adminTwoFactor.authenticatorRequired = true;
    expect(await mustEnrolAuthenticator(admin() as never, true)).toBe(true);
    expect(await mustEnrolAuthenticator(admin() as never, false)).toBe(false);
    expect(await mustEnrolAuthenticator(admin({ totpSecretEnc: 'x', totpEnrolledAt: NOW }) as never, true)).toBe(false);
  });

  it('the challenge still lists SMS/EMAIL while required and un-enrolled — the person has to get in to enrol', async () => {
    settings.auth.adminTwoFactor.authenticatorRequired = true;
    const challenge = await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' });
    expect(challenge.methods).toEqual(['SMS', 'EMAIL']);
  });

  it('smsAllowedWhenEnrolled off lists AUTHENTICATOR alone, refuses a sent channel, and a recovery code still works', async () => {
    const { done } = await enrol();
    settings.auth.adminTwoFactor.smsAllowedWhenEnrolled = false;
    expect(await availableMethods('adm_1', 'asha.rao@adx.co')).toEqual(['AUTHENTICATOR']);
    const challenge = await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' });
    expect(challenge.methods).toEqual(['AUTHENTICATOR']);
    await expect(sendTwoFactorCode(challenge.challengeToken, 'SMS')).rejects.toMatchObject({ statusCode: 403, details: { methods: ['AUTHENTICATOR'] } });
    await expect(sendTwoFactorCode(challenge.challengeToken, 'EMAIL')).rejects.toMatchObject({ statusCode: 403 });
    expect(otp.sendOtp).not.toHaveBeenCalled();
    const result = await verifyTwoFactorCode(challenge.challengeToken, done.recoveryCodes[0]!);
    expect(result.method).toBe('RECOVERY_CODE');
  });
});

/* M-B: the mobile OTP door. */
describe('the challenge after a mobile OTP', () => {
  const who = { id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' };

  it('lists the email backup alone for an un-enrolled admin under the default policy — the phone was the SMS factor, never SMS again', async () => {
    const challenge = await issueChallengeAfterMobileOtp(who);
    expect(challenge.methods).toEqual(['EMAIL']);
    expect(challenge.maskedMobile).toBe('+91 ***** 2210');
    expect(readChallengeClaims(challenge.challengeToken)).toEqual({ userId: 'adm_1', methods: ['EMAIL'] });
    expect(repository.stampTwoFactorRequired).toHaveBeenCalledWith('adm_1');
    // The password login's challenge is unbounded, as it always was.
    expect(readChallengeClaims((await issueChallenge(who)).challengeToken)).toEqual({ userId: 'adm_1', methods: null });
  });

  it('lists the app and the email backup once enrolled, and the app alone when the policy keeps SMS off an enrolled admin', async () => {
    await enrol();
    expect((await issueChallengeAfterMobileOtp(who)).methods).toEqual(['AUTHENTICATOR', 'EMAIL']);
    settings.auth.adminTwoFactor.smsAllowedWhenEnrolled = false;
    expect((await issueChallengeAfterMobileOtp(who)).methods).toEqual(['AUTHENTICATOR']);
  });

  it('under authenticatorRequired the code bought nothing: the app alone once enrolled, and no challenge at all without one', async () => {
    settings.auth.adminTwoFactor.authenticatorRequired = true;
    await expect(issueChallengeAfterMobileOtp(who)).rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_SIGN_IN_REQUIRED', details: { loginAt: '/api/v1/auth/login-password' } });
    await enrol();
    expect((await issueChallengeAfterMobileOtp(who)).methods).toEqual(['AUTHENTICATOR']);
  });

  it('closes the door with ADMIN_SIGN_IN_REQUIRED when nothing is left to answer — no enrolment, no email, or the backup spent', async () => {
    await expect(issueChallengeAfterMobileOtp({ ...who, email: null })).rejects.toMatchObject({ code: 'ADMIN_SIGN_IN_REQUIRED' });
    repository.findUser.mockResolvedValue(admin({ emailOtpFallbackCount: 3, emailOtpFallbackResetAt: new Date() }));
    await expect(issueChallengeAfterMobileOtp(who)).rejects.toMatchObject({ code: 'ADMIN_SIGN_IN_REQUIRED' });
  });

  it('/2fa/send refuses a channel the challenge does not list, before anything is sent', async () => {
    const { challengeToken } = await issueChallengeAfterMobileOtp(who);
    await expect(sendTwoFactorCode(challengeToken, 'SMS')).rejects.toMatchObject({ statusCode: 403, details: { methods: ['EMAIL'] } });
    expect(otp.sendOtp).not.toHaveBeenCalled();
    await expect(sendTwoFactorCode(challengeToken, 'AUTHENTICATOR')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('/2fa/verify refuses a live SMS code against a challenge that spent SMS, and takes the app or a recovery code', async () => {
    const { done, secret } = await enrol();
    const { challengeToken } = await issueChallengeAfterMobileOtp(who);
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_1', purpose: 'TWO_FACTOR', attempts: 0, codeHash: 'x' });
    await expect(verifyTwoFactorCode(challengeToken, '123456')).rejects.toMatchObject({ statusCode: 403, details: { methods: ['AUTHENTICATOR', 'EMAIL'] } });
    expect(otp.verifyOtp).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_FAILED', expect.objectContaining({ metadata: { reason: 'SMS_NOT_IN_CHALLENGE' } }));

    repository.findLatestTwoFactorOtp.mockResolvedValue(null);
    expect((await verifyTwoFactorCode(challengeToken, totp(secret))).method).toBe('AUTHENTICATOR');
    forgetUsedSteps();
    expect((await verifyTwoFactorCode(challengeToken, done.recoveryCodes[0]!)).method).toBe('RECOVERY_CODE');
  });

  it("/2fa/verify refuses the app's code against a challenge that does not list it", async () => {
    // The challenge was minted before the enrolment, so it lists EMAIL alone.
    const { challengeToken } = await issueChallengeAfterMobileOtp(who);
    const { secret } = await enrol();
    await expect(verifyTwoFactorCode(challengeToken, totp(secret))).rejects.toMatchObject({ statusCode: 403, details: { methods: ['EMAIL'] } });
  });
});

/* M-B: the policy is read when the code is verified, not when it was sent. */
describe('a policy flip after a code was sent', () => {
  const challengeFor = async () => (await issueChallenge({ id: 'adm_1', mobile: '+919845012210', email: 'asha.rao@adx.co' })).challengeToken;

  it('a live SMS or email code for an enrolled admin opens nothing once smsAllowedWhenEnrolled is off; the app still does', async () => {
    const { secret } = await enrol();
    const token = await challengeFor();
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_1', purpose: 'TWO_FACTOR', attempts: 0, codeHash: 'x' });
    otp.verifyOtp.mockResolvedValue('adm_1');
    settings.auth.adminTwoFactor.smsAllowedWhenEnrolled = false;

    // The six digits are read as the app's code now — the SMS row is never consulted.
    await expect(verifyTwoFactorCode(token, '000000')).rejects.toMatchObject({ statusCode: 401 });
    expect(otp.verifyOtp).not.toHaveBeenCalled();
    expect(repository.findLatestTwoFactorOtp).not.toHaveBeenCalled();

    const codeHash = await bcrypt.hash('ABCD23WXYZ', 10);
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_2', purpose: 'TWO_FACTOR_EMAIL', attempts: 0, codeHash });
    await expect(verifyTwoFactorCode(token, 'ABCD23WXYZ')).rejects.toMatchObject({ statusCode: 401 });
    expect(repository.markVerified).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'LOGIN_2FA_FAILED', expect.objectContaining({ metadata: { reason: 'SENT_CHANNEL_NOT_ALLOWED' } }));

    expect((await verifyTwoFactorCode(token, totp(secret))).method).toBe('AUTHENTICATOR');
  });

  it('an un-enrolled admin is untouched by the switch — the SMS code still signs in', async () => {
    settings.auth.adminTwoFactor.smsAllowedWhenEnrolled = false;
    repository.findLatestTwoFactorOtp.mockResolvedValue({ id: 'otp_1', purpose: 'TWO_FACTOR', attempts: 0, codeHash: 'x' });
    otp.verifyOtp.mockResolvedValue('adm_1');
    expect((await verifyTwoFactorCode(await challengeFor(), '123456')).method).toBe('SMS');
  });
});

describe('the status read', () => {
  it('says not enrolled with no codes, then enrolled with the stamp and the codes left', async () => {
    await expect(authenticatorStatus(admin() as never)).resolves.toEqual({ enrolled: false, enrolledAt: null, recoveryCodesLeft: 0 });
    expect(repository.countUnusedRecoveryCodes).not.toHaveBeenCalled();
    const { enrolled, done } = await enrol();
    repository.countUnusedRecoveryCodes.mockResolvedValue(10);
    await expect(authenticatorStatus(enrolled as never)).resolves.toEqual({ enrolled: true, enrolledAt: done.enrolledAt, recoveryCodesLeft: 10 });
  });
});
