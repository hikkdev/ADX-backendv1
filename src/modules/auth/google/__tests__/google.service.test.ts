import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security boundary of Google sign-in.
 *
 * Everything here runs against a locally generated RSA keypair standing in for
 * Google's, with the JWKS endpoint stubbed — so the suite touches no network,
 * no Postgres and no Redis, and can assert the cases that matter most: tokens
 * that are real but meant for someone else, and forgeries that try to talk the
 * verifier out of checking the signature properly.
 */

const CLIENT_ID = 'adx-test-client.apps.googleusercontent.com';
const KID = 'test-key-1';

// vi.hoisted, because vi.mock factories are lifted above the imports below and
// would otherwise close over a not-yet-initialised binding. Mutable so each
// test can set the policy it needs; google.service reads it through the same
// module object, so an assignment takes effect immediately.
const env = vi.hoisted(() => ({
  GOOGLE_CLIENT_ID: 'adx-test-client.apps.googleusercontent.com' as string | undefined,
  GOOGLE_ALLOWED_DOMAINS: '',
}));
vi.mock('../../../../config/env', () => ({ env }));

import { isGoogleSignInConfigured, resetGoogleKeyCache, verifyGoogleIdToken } from '../google.service';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwkFor(key: crypto.KeyObject, kid: string): Record<string, unknown> {
  return { ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

/** Stands in for https://www.googleapis.com/oauth2/v3/certs. */
function stubJwks(keys: Record<string, unknown>[], cacheControl = 'public, max-age=3600') {
  const fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'cache-control': cacheControl }),
        json: async () => ({ keys }),
      }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type Claims = Record<string, unknown>;

/** A well-formed Workspace ID token, before any test bends one field out of shape. */
function signIdToken(overrides: Claims = {}, options: jwt.SignOptions = {}): string {
  const claims: Claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '110000000000000000001',
    email: 'ada@adx.co',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/ada',
    hd: 'adx.co',
    ...overrides,
  };

  return jwt.sign(claims, privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    expiresIn: '5m',
    ...options,
  });
}

/** Asserts the thrown value is an ApiError with this status, and returns it. */
async function expectApiError(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught as { statusCode?: number; code?: string; message?: string },
  );
  expect(error, `expected a ${status} rejection but the call resolved`).not.toBeNull();
  expect(error!.statusCode).toBe(status);
  return error!;
}

beforeEach(() => {
  env.GOOGLE_CLIENT_ID = CLIENT_ID;
  env.GOOGLE_ALLOWED_DOMAINS = '';
  resetGoogleKeyCache();
  stubJwks([jwkFor(publicKey, KID)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyGoogleIdToken — accepts a genuine token', () => {
  it('returns the identity Google asserted', async () => {
    const identity = await verifyGoogleIdToken(signIdToken());

    expect(identity).toEqual({
      sub: '110000000000000000001',
      email: 'ada@adx.co',
      emailVerified: true,
      name: 'Ada Lovelace',
      picture: 'https://lh3.googleusercontent.com/a/ada',
      hostedDomain: 'adx.co',
    });
  });

  it('accepts the bare "accounts.google.com" issuer spelling', async () => {
    const identity = await verifyGoogleIdToken(signIdToken({ iss: 'accounts.google.com' }));
    expect(identity.sub).toBe('110000000000000000001');
  });

  it('lower-cases the email, so the account lookup is not case-dependent', async () => {
    const identity = await verifyGoogleIdToken(signIdToken({ email: 'Ada.Lovelace@ADX.co' }));
    expect(identity.email).toBe('ada.lovelace@adx.co');
  });

  it('accepts email_verified sent as the string "true"', async () => {
    const identity = await verifyGoogleIdToken(signIdToken({ email_verified: 'true' }));
    expect(identity.emailVerified).toBe(true);
  });

  it('omits hostedDomain for a personal account when no allowlist is set', async () => {
    const identity = await verifyGoogleIdToken(signIdToken({ hd: undefined }));
    expect(identity.hostedDomain).toBeUndefined();
  });
});

describe('verifyGoogleIdToken — rejects forged and misdirected tokens', () => {
  it('rejects a token minted for a different Google app (wrong aud)', async () => {
    const token = signIdToken({ aud: 'someone-elses-app.apps.googleusercontent.com' });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects a token from a non-Google issuer', async () => {
    const token = signIdToken({ iss: 'https://evil.example.com' });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects an expired token', async () => {
    const token = signIdToken({}, { expiresIn: '-10m' });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects a token signed by a key Google does not publish', async () => {
    const token = jwt.sign(
      {
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: '1',
        email: 'ada@adx.co',
        email_verified: true,
      },
      otherKeypair.privateKey,
      // Claims the real kid, but the signature will not check out against it.
      { algorithm: 'RS256', keyid: KID, expiresIn: '5m' },
    );
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects a token whose kid is not in the JWKS', async () => {
    const token = signIdToken({}, { keyid: 'a-key-that-does-not-exist' });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects an HS256 token forged with the client id as the shared secret', async () => {
    // The classic algorithm-confusion attack: a verifier that reads `alg` from
    // the token itself would HMAC-verify this against a public value.
    const token = jwt.sign(
      {
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: '1',
        email: 'ada@adx.co',
        email_verified: true,
      },
      CLIENT_ID,
      { algorithm: 'HS256', keyid: KID, expiresIn: '5m' },
    );
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${b64({ alg: 'none', typ: 'JWT', kid: KID })}.${b64({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '1',
      email: 'ada@adx.co',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 300,
    })}.`;
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects a token with no kid header', async () => {
    const token = jwt.sign({ sub: '1' }, privateKey, { algorithm: 'RS256' });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects a string that is not a JWT at all', async () => {
    await expectApiError(verifyGoogleIdToken('not-a-jwt'), 401);
  });

  it('rejects a token whose email is not verified', async () => {
    const token = signIdToken({ email_verified: false });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('rejects a token carrying no email claim', async () => {
    const token = signIdToken({ email: undefined });
    await expectApiError(verifyGoogleIdToken(token), 401);
  });

  it('reports every rejection with the same opaque message', async () => {
    const wrongAudience = await expectApiError(
      verifyGoogleIdToken(signIdToken({ aud: 'other' })),
      401,
    );
    const expired = await expectApiError(
      verifyGoogleIdToken(signIdToken({}, { expiresIn: '-1m' })),
      401,
    );

    expect(wrongAudience.message).toBe(expired.message);
    expect(wrongAudience.message).toBe('Google sign-in could not be verified');
  });
});

describe('verifyGoogleIdToken — Workspace domain allowlist', () => {
  it('accepts an account in an allowed domain', async () => {
    env.GOOGLE_ALLOWED_DOMAINS = 'adx.co';
    const identity = await verifyGoogleIdToken(signIdToken());
    expect(identity.hostedDomain).toBe('adx.co');
  });

  it('accepts any domain in a comma-separated list, ignoring spacing and case', async () => {
    env.GOOGLE_ALLOWED_DOMAINS = ' Example.com , ADX.co ';
    const identity = await verifyGoogleIdToken(signIdToken({ hd: 'adx.co' }));
    expect(identity.hostedDomain).toBe('adx.co');
  });

  it('rejects a personal gmail account (no hd claim) with 403', async () => {
    env.GOOGLE_ALLOWED_DOMAINS = 'adx.co';
    const token = signIdToken({ hd: undefined, email: 'ada@gmail.com' });
    const error = await expectApiError(verifyGoogleIdToken(token), 403);
    // Actionable on purpose: the user picked the wrong account in the popup.
    expect(error.message).toContain('work Google account');
  });

  it('rejects a Workspace account from an unlisted domain with 403', async () => {
    env.GOOGLE_ALLOWED_DOMAINS = 'adx.co';
    const token = signIdToken({ hd: 'competitor.example', email: 'ada@competitor.example' });
    await expectApiError(verifyGoogleIdToken(token), 403);
  });

  it('checks the domain against the signed hd claim, never the email suffix', async () => {
    // An account at some other Workspace whose alias merely looks like ours.
    env.GOOGLE_ALLOWED_DOMAINS = 'adx.co';
    const token = signIdToken({ hd: 'attacker.example', email: 'ceo@adx.co' });
    await expectApiError(verifyGoogleIdToken(token), 403);
  });
});

describe('verifyGoogleIdToken — configuration', () => {
  it('answers 503 rather than letting anyone in when the client id is unset', async () => {
    env.GOOGLE_CLIENT_ID = undefined;
    const error = await expectApiError(verifyGoogleIdToken(signIdToken()), 503);
    expect(error.message).toContain('not configured');
  });

  it('isGoogleSignInConfigured tracks the client id', () => {
    expect(isGoogleSignInConfigured()).toBe(true);
    env.GOOGLE_CLIENT_ID = undefined;
    expect(isGoogleSignInConfigured()).toBe(false);
  });
});

describe('JWKS handling', () => {
  it('caches the key set instead of refetching on every sign-in', async () => {
    const fetchMock = stubJwks([jwkFor(publicKey, KID)]);

    await verifyGoogleIdToken(signIdToken());
    await verifyGoogleIdToken(signIdToken());
    await verifyGoogleIdToken(signIdToken());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once when a token names a kid the cache has not seen', async () => {
    const rotated = 'test-key-2';
    const page = (keys: Record<string, unknown>[]) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'cache-control': 'max-age=3600' }),
      json: async () => ({ keys }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([jwkFor(publicKey, KID)]))
      .mockResolvedValueOnce(page([jwkFor(publicKey, KID), jwkFor(publicKey, rotated)]));
    vi.stubGlobal('fetch', fetchMock);

    // First call warms the cache with only the old key.
    await verifyGoogleIdToken(signIdToken());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Google rotated: the new token is signed under a kid the cache lacks.
    await verifyGoogleIdToken(signIdToken({}, { keyid: rotated }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps miss-driven refetches, so a made-up kid cannot amplify onto Google', async () => {
    const fetchMock = stubJwks([jwkFor(publicKey, KID)]);

    // Warms the cache. Every call after this names a kid that is not in it.
    await verifyGoogleIdToken(signIdToken());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expectApiError(
        verifyGoogleIdToken(signIdToken({}, { keyid: `made-up-kid-${attempt}` })),
        401,
      );
    }

    // 1 warm-up + at most the per-window budget, not one per attempt.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('collapses concurrent cold-cache lookups into a single outbound request', async () => {
    const fetchMock = stubJwks([jwkFor(publicKey, KID)]);

    await Promise.all([
      verifyGoogleIdToken(signIdToken()),
      verifyGoogleIdToken(signIdToken()),
      verifyGoogleIdToken(signIdToken()),
      verifyGoogleIdToken(signIdToken()),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still lets a genuine key rotation through on its first attempt', async () => {
    // The reason the cap is a budget and not a fixed cooldown: a rotation must
    // not have to wait out a timer.
    const rotated = 'test-key-2';
    const page = (keys: Record<string, unknown>[]) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'cache-control': 'max-age=3600' }),
      json: async () => ({ keys }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([jwkFor(publicKey, KID)]))
      .mockResolvedValueOnce(page([jwkFor(publicKey, rotated)]));
    vi.stubGlobal('fetch', fetchMock);

    await verifyGoogleIdToken(signIdToken());
    const identity = await verifyGoogleIdToken(signIdToken({}, { keyid: rotated }));

    expect(identity.email).toBe('ada@adx.co');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips a key published for encryption rather than signing', async () => {
    const encryptionKey = { ...jwkFor(publicKey, 'enc-key'), use: 'enc' };
    stubJwks([encryptionKey, jwkFor(publicKey, KID)]);

    // The signing key is still found...
    const identity = await verifyGoogleIdToken(signIdToken());
    expect(identity.email).toBe('ada@adx.co');

    // ...but a token naming the encryption key is not verifiable against it.
    await expectApiError(verifyGoogleIdToken(signIdToken({}, { keyid: 'enc-key' })), 401);
  });

  it('skips non-RSA entries rather than failing on the whole key set', async () => {
    stubJwks([
      { kty: 'EC', kid: 'ec-key', crv: 'P-256', x: 'unused', y: 'unused' },
      jwkFor(publicKey, KID),
    ]);
    const identity = await verifyGoogleIdToken(signIdToken());
    expect(identity.email).toBe('ada@adx.co');
  });

  it('answers 503 when Google is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expectApiError(verifyGoogleIdToken(signIdToken()), 503);
  });

  it('answers 503 when the JWKS endpoint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({}) })),
    );
    await expectApiError(verifyGoogleIdToken(signIdToken()), 503);
  });

  it('answers 503 when the JWKS contains no usable key', async () => {
    stubJwks([{ kty: 'EC', kid: 'ec-only', crv: 'P-256', x: 'unused', y: 'unused' }]);
    await expectApiError(verifyGoogleIdToken(signIdToken()), 503);
  });
});
