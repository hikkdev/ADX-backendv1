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

vi.mock('../../../../shared/audit', () => ({
  logActivity: mocks.logActivity,
  listActivity: vi.fn(),
}));

import { app } from '../../../../app';
import { redis } from '../../../../shared/cache';
import { ApiError } from '../../../../shared/errors';

const IDENTITY = {
  sub: '110000000000000000001',
  email: 'ada@adx.co',
  emailVerified: true,
  name: 'Ada Lovelace',
  hostedDomain: 'adx.co',
};

function adxUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usr_ada',
    mobile: '+919876543210',
    name: 'Ada Lovelace',
    email: 'ada@adx.co',
    language: 'en',
    avatarUrl: null,
    passwordHash: null,
    isActive: true,
    roles: [{ role: 'ADMIN' }],
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
        user: { id: 'usr_ada', email: 'ada@adx.co', roles: ['ADMIN'] },
      },
    });
  });

  it('looks the account up by the email Google asserted', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser()]);

    await signIn();

    expect(mocks.findLoginUsersByEmailInsensitive).toHaveBeenCalledWith('ada@adx.co');
  });

  it('starts a session with the roles the account actually holds', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ roles: [{ role: 'ADMIN' }, { role: 'PARTNER' }] }),
    ]);

    await signIn();

    expect(mocks.startSession).toHaveBeenCalledWith(
      'usr_ada',
      ['ADMIN', 'PARTNER'],
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
      expect.objectContaining({ googleSub: IDENTITY.sub, hostedDomain: 'adx.co' }),
    );
  });
});

describe('POST /auth/google — refuses to provision or guess', () => {
  it('rejects an unknown email with 403 and never starts a session', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([]);

    const res = await signIn();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // The whole point of the policy: authentication, not registration.
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('names the reason for an unknown email — the caller already owns that mailbox', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([]);

    const res = await signIn();

    expect(res.body.error.message).toContain('administrator');
  });

  it('rejects a deactivated account with 401', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([adxUser({ isActive: false })]);

    const res = await signIn();

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Account not active');
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('refuses with 409 when two accounts differ only by email case', async () => {
    mocks.findLoginUsersByEmailInsensitive.mockResolvedValue([
      adxUser({ id: 'usr_one', email: 'ada@adx.co' }),
      adxUser({ id: 'usr_two', email: 'Ada@adx.co' }),
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
