import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The account-decision half of Google sign-in, driven through the real Express
 * app so the route, its middleware chain and the error handler are all in the
 * path.
 *
 * The verifier and the repository are stubbed: `google.service.test.ts` already
 * proves the cryptography, and what is left to pin down is the policy — who is
 * allowed a session once Google has vouched for them. Stubbing the repository
 * also keeps this suite off Postgres, like the rest of the suite.
 *
 * vi.hoisted is load-bearing: vi.mock factories are lifted above every import
 * below, so the doubles have to be created up there with them.
 */
const mocks = vi.hoisted(() => ({
  verifyGoogleIdToken: vi.fn(),
  findLoginUsersByEmailInsensitive: vi.fn(),
  startSession: vi.fn(),
  logActivity: vi.fn(),
  issueChallenge: vi.fn(),
  // G-2 / ED-1: the hand-off for a new address and the stamp for a known one.
  signupHandoffForProvenEmail: vi.fn(),
  stampProvenEmail: vi.fn(),
}));

vi.mock('../../otp/otp.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../otp/otp.service')>()),
  signupHandoffForProvenEmail: mocks.signupHandoffForProvenEmail,
  stampProvenEmail: mocks.stampProvenEmail,
}));

vi.mock('../google.service', () => ({ verifyGoogleIdToken: mocks.verifyGoogleIdToken }));

vi.mock('../../prisma-auth.repository', () => ({
  prismaAuthRepository: {
    findLoginUsersByEmailInsensitive: mocks.findLoginUsersByEmailInsensitive,
  },
}));

vi.mock('../../auth.session', () => ({
  sessionMeta: () => ({ userAgent: 'vitest', ipAddress: '127.0.0.1' }),
  startSession: mocks.startSession,
}));

// Partial: the whole app is loaded below, and the audit module reads other
// exports from here (ACTIVITY_SORTS and friends) while building its schemas.
vi.mock('../../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/audit')>()),
  logActivity: mocks.logActivity,
  listActivity: vi.fn(),
}));

/* Lot A (Q25): an ADMIN gets a challenge here rather than tokens. Only the
 * challenge itself is stubbed — `isAdmin` stays real, so the branch this file
 * cares about is the one under test, and no database is touched. */
vi.mock('../../two-factor/two-factor.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../two-factor/two-factor.service')>()),
  issueChallenge: mocks.issueChallenge,
}));

import { app } from '../../../../app';
import { redis } from '../../../../shared/cache';
import { ApiError } from '../../../../shared/errors';

const IDENTITY = {
  sub: '110000000000000000001',
  email: 'ada@adx.in',
  emailVerified: true,
  name: 'Ada Lovelace',
  hostedDomain: 'adx.in',
};

function adxUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usr_ada',
    mobile: '+919876543210',
    name: 'Ada Lovelace',
    email: 'ada@adx.in',
    language: 'en',
    avatarUrl: null,
    passwordHash: null,
    isActive: true,
    // Deliberately NOT an admin: an admin's Google sign-in answers with a
    // second-factor challenge, which has its own describe below.
    roles: [{ role: 'PARTNER' }],
    agentProfile: null,
    publisherProfile: null,
    ...overrides,
  };
}

function signIn(idToken = 'a-google-id-token') {
  return request(app).post('/api/v1/auth/google').send({ idToken });
}

beforeEach(async () => {
  // googleAuthLimiter counts in Redis, which outlives the process — without
  // this the suite exhausts its own 20-request budget and later runs 429.
  // Clearing beats mocking the limiter out: the real middleware chain stays
  // under test.
  const keys = await redis.keys('rl:google-auth:*');
  if (keys.length > 0) await redis.del(...keys);

  vi.clearAllMocks();
  mocks.verifyGoogleIdToken.mockResolvedValue(IDENTITY);
  mocks.startSession.mockResolvedValue({
    accessToken: 'adx-access',
    refreshToken: 'adx-refresh',
  });
  mocks.logActivity.mockResolvedValue(undefined);
  mocks.issueChallenge.mockResolvedValue({
    challengeToken: 'challenge-token',
    methods: ['SMS', 'EMAIL'],
    maskedMobile: '+91 ***** 3210',
    maskedEmail: 'a**a@adx.in',
  });
});

describe('POST /auth/google — a verified identity with a matching account', () => {
  it('issues the ADX token pair and the login user payload', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser()]);

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        accessToken: 'adx-access',
        refreshToken: 'adx-refresh',
        user: { id: 'usr_ada', email: 'ada@adx.in', roles: ['PARTNER'] },
      },
    });
  });

  it('looks the account up by the email Google asserted', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser()]);

    await signIn();

    expect(mocks.findLoginUsersByEmailInsensitive).toHaveBeenCalledWith('ada@adx.in');
  });

  it('starts a session with the roles the account actually holds', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ roles: [{ role: 'PARTNER' }, { role: 'PUBLISHER' }] }),
    ]);

    await signIn();

    expect(mocks.startSession).toHaveBeenCalledWith(
      'usr_ada',
      ['PARTNER', 'PUBLISHER'],
      expect.anything(),
    );
  });

  it('reports hasPassword from the stored hash, not from the fact of signing in', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser({ passwordHash: null })]);
    const googleOnly = await signIn();
    expect(googleOnly.body.data.user.hasPassword).toBe(false);

    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ passwordHash: 'argon-ish' }),
    ]);
    const alsoHasPassword = await signIn();
    expect(alsoHasPassword.body.data.user.hasPassword).toBe(true);
  });

  it('never returns the password hash', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ passwordHash: 'secret-hash' }),
    ]);

    const res = await signIn();

    expect(JSON.stringify(res.body)).not.toContain('secret-hash');
  });

  it('writes a LOGIN_GOOGLE activity entry carrying the Google subject', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser()]);

    await signIn();

    expect(mocks.logActivity).toHaveBeenCalledWith(
      'usr_ada',
      'LOGIN_GOOGLE',
      expect.anything(),
      expect.objectContaining({ googleSub: IDENTITY.sub, hostedDomain: 'adx.in' }),
    );
  });
});

/* Lot A (Q25). Google proved the mailbox, not the phone. */
describe('POST /auth/google — an admin gets a challenge, not tokens', () => {
  const admin = () => [adxUser({ roles: [{ role: 'ADMIN' }] })];

  it('answers 200 with the challenge and starts no session', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue(admin());

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        challenge: {
          challengeToken: 'challenge-token',
          methods: ['SMS', 'EMAIL'],
          maskedMobile: '+91 ***** 3210',
          maskedEmail: 'a**a@adx.in',
        },
      },
    });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('records the challenge against the account, naming the method it came from', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue(admin());

    await signIn();

    expect(mocks.logActivity).toHaveBeenCalledWith(
      'usr_ada',
      'LOGIN_2FA_CHALLENGED',
      expect.anything(),
      expect.objectContaining({ method: 'google' }),
    );
  });

  it('a deactivated admin is still refused before any challenge is issued', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ roles: [{ role: 'ADMIN' }], isActive: false }),
    ]);

    const res = await signIn();

    expect(res.status).toBe(401);
    expect(mocks.issueChallenge).not.toHaveBeenCalled();
  });
});

describe('POST /auth/google — a sign-up door (G-2), never a guess', () => {
  it('hands a new, Google-verified address to the phone step and starts no session', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([]);
    mocks.signupHandoffForProvenEmail.mockResolvedValue({ kind: 'signup', signupToken: 'signup-1', email: 'ada@adx.in', expiresInSeconds: 1800 });

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ signup: { signupToken: 'signup-1', email: 'ada@adx.in', expiresInSeconds: 1800 } });
    expect(mocks.signupHandoffForProvenEmail).toHaveBeenCalledWith('ada@adx.in');
    // The account opens on the phone step, not here.
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('an address Google has not verified is still refused with 403', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([]);
    mocks.verifyGoogleIdToken.mockResolvedValue({ ...IDENTITY, emailVerified: false });

    const res = await signIn();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mocks.signupHandoffForProvenEmail).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('rejects a deactivated account with 401', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser({ isActive: false })]);

    const res = await signIn();

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Account not active');
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('account lifecycle (2 Oct 2026): rejects a closed account the same way, even with the switch still on', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser({ isActive: true, closedAt: new Date() })]);

    const res = await signIn();

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Account not active');
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('refuses with 409 when two accounts differ only by email case', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ id: 'usr_one', email: 'ada@adx.in' }),
      adxUser({ id: 'usr_two', email: 'Ada@adx.in' }),
    ]);

    const res = await signIn();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    // Signing one of them in would be arbitrary — an account-confusion bug.
    expect(mocks.startSession).not.toHaveBeenCalled();
  });
});

describe('POST /auth/google — surfaces verifier failures unchanged', () => {
  it('passes a 401 from the verifier straight through', async () => {
    mocks.verifyGoogleIdToken.mockRejectedValue(
      new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified'),
    );

    const res = await signIn();

    expect(res.status).toBe(401);
    expect(mocks.findLoginUsersByEmailInsensitive).not.toHaveBeenCalled();
  });

  it('passes the 403 domain rejection through with its actionable message', async () => {
    mocks.verifyGoogleIdToken.mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', 'Use your work Google account to sign in to ADX Admin.'),
    );

    const res = await signIn();

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('work Google account');
  });

  it('rejects a request with no idToken before calling the verifier', async () => {
    const res = await request(app).post('/api/v1/auth/google').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.verifyGoogleIdToken).not.toHaveBeenCalled();
  });
});
