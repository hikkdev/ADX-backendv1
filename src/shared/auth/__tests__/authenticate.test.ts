import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * authenticate() beyond the signature: the revocation marker, the read-only
 * guard on an impersonation token, the refusal of a 2FA challenge token, and
 * requirePermission with the launch rule for tokens minted without perms.
 */
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../cache/redis', () => ({ redis }));

import { env } from '../../../config/env';
import { errorHandler } from '../../errors';
import { ENROLMENT_ONLY_PATHS, authenticate, hasPermission, requirePermission, requireRole } from '../authenticate';
import { signAccessToken, signImpersonationToken } from '../jwt';
import { clearRevocationMemo, markSessionsRevoked } from '../revocation';

function appWith() {
  const app = express();
  app.use(authenticate);
  app.get('/whoami', (req, res) => {
    res.json({ sub: req.user?.sub, act: req.user?.act ?? null });
  });
  app.post('/write', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/finance', requirePermission('finance.approve'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/two', requirePermission('finance.view', 'kyc.edit'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/admin', requireRole('ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.clearAllMocks();
  clearRevocationMemo();
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
});

describe('revocation', () => {
  it('lets a token through when no marker exists', async () => {
    const res = await request(appWith()).get('/whoami').set(bearer(signAccessToken('usr_1', ['ADMIN'])));
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe('usr_1');
    expect(redis.get).toHaveBeenCalledWith('auth:revoked:usr_1');
  });

  it('refuses a token issued before the marker and accepts one issued after', async () => {
    const before = signAccessToken('usr_1', ['ADMIN']);
    const at = new Date(Date.now() + 5_000);
    await markSessionsRevoked('usr_1', at);
    expect(redis.set).toHaveBeenCalledWith('auth:revoked:usr_1', String(Math.floor(at.getTime() / 1000)), 'EX', expect.any(Number));
    redis.get.mockResolvedValue(String(Math.floor(at.getTime() / 1000)));

    const refused = await request(appWith()).get('/whoami').set(bearer(before));
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const later = jwt.sign({ sub: 'usr_1', roles: ['ADMIN'], iat: Math.floor(at.getTime() / 1000) + 1 }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const ok = await request(appWith()).get('/whoami').set(bearer(later));
    expect(ok.status).toBe(200);
  });

  it('memoises the marker read for a burst of requests from one user', async () => {
    const app = appWith();
    const token = signAccessToken('usr_2', ['ADMIN']);
    await request(app).get('/whoami').set(bearer(token));
    await request(app).get('/whoami').set(bearer(token));
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis is unreachable', async () => {
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(appWith()).get('/whoami').set(bearer(signAccessToken('usr_3', ['ADMIN'])));
    expect(res.status).toBe(200);
  });

  it('ends an impersonation when the acting admin is revoked', async () => {
    const token = signImpersonationToken('pub_1', ['PUBLISHER'], { sub: 'adm_1', sessionId: 'imp_1' });
    redis.get.mockImplementation(async (key: string) => (key === 'auth:revoked:adm_1' ? String(Math.floor(Date.now() / 1000) + 60) : null));
    const res = await request(appWith()).get('/whoami').set(bearer(token));
    expect(res.status).toBe(401);
  });
});

describe('an impersonation token', () => {
  const token = signImpersonationToken('pub_1', ['PUBLISHER'], { sub: 'adm_1', sessionId: 'imp_1' });

  it('reads as the target, with the admin on req.user.act', async () => {
    const res = await request(appWith()).get('/whoami').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: 'pub_1', act: { sub: 'adm_1', sessionId: 'imp_1' } });
  });

  it('cannot write anywhere', async () => {
    const res = await request(appWith()).post('/write').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'IMPERSONATION_READ_ONLY' } });
  });
});

describe('a 2FA challenge token', () => {
  it('is refused by authenticate even though it is signed with the access secret', async () => {
    const challenge = jwt.sign({ sub: 'adm_1', purpose: '2fa' }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
    const res = await request(appWith()).get('/whoami').set(bearer(challenge));
    expect(res.status).toBe(401);
  });

  it('as is a signed token with no roles', async () => {
    const odd = jwt.sign({ sub: 'adm_1' }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
    const res = await request(appWith()).get('/whoami').set(bearer(odd));
    expect(res.status).toBe(401);
  });
});

describe('requirePermission', () => {
  it('lets a token holding the id through and names what is missing otherwise', async () => {
    const app = appWith();
    const held = signAccessToken('usr_1', ['ADMIN'], undefined, { perms: ['finance.approve'] });
    expect((await request(app).get('/finance').set(bearer(held))).status).toBe(200);

    const lacking = signAccessToken('usr_1', ['ADMIN'], undefined, { perms: ['finance.view'] });
    const res = await request(app).get('/two').set(bearer(lacking));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'FORBIDDEN', details: { missing: ['kyc.edit'] } } });
  });

  it('applies the launch rule to a token minted without perms: an ADMIN holds everything, nobody else holds anything', async () => {
    const app = appWith();
    expect((await request(app).get('/finance').set(bearer(signAccessToken('usr_1', ['ADMIN'])))).status).toBe(200);
    expect((await request(app).get('/finance').set(bearer(signAccessToken('usr_1', ['PUBLISHER'])))).status).toBe(403);
    expect(hasPermission({ roles: ['ADMIN'], perms: [] }, 'finance.view')).toBe(false);
    expect(hasPermission(undefined, 'finance.view')).toBe(false);
  });

  it('is named so the route inventory records it', () => {
    expect(requirePermission('finance.view', 'kyc.edit').name).toBe('requirePermission(finance.view|kyc.edit)');
  });
});

/* Lot K2: the must-enrol claim. */
describe('a token carrying mustEnrolAuthenticator', () => {
  function enrolmentApp() {
    const app = express();
    app.use('/api/v1', (req, res, next) => authenticate(req, res, next));
    app.get('/api/v1/users/me', (_req, res) => res.json({ ok: true }));
    app.patch('/api/v1/users/me', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/auth/2fa/totp/enrol', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/users/me/sessions', (_req, res) => res.json({ ok: true }));
    app.post('/api/v1/auth/2fa/totp/enrol', (_req, res) => res.json({ ok: true }));
    app.post('/api/v1/auth/2fa/totp/confirm', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/auth/2fa/status', (_req, res) => res.json({ ok: true }));
    app.post('/api/v1/auth/logout', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/orders', (_req, res) => res.json({ ok: true }));
    app.post('/api/v1/users', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  }

  it('is stamped only when asked, and read back as the claim', () => {
    const plain = jwt.decode(signAccessToken('adm_1', ['ADMIN'])) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('mustEnrolAuthenticator');
    const held = jwt.decode(signAccessToken('adm_1', ['ADMIN'], 'ses_1', { perms: [], mustEnrolAuthenticator: true })) as Record<string, unknown>;
    expect(held['mustEnrolAuthenticator']).toBe(true);
    expect(jwt.decode(signAccessToken('adm_1', ['ADMIN'], undefined, { mustEnrolAuthenticator: false }))).not.toHaveProperty('mustEnrolAuthenticator');
  });

  it('opens the enrolment, status, logout and /users/me routes, and nothing else — 403 TOTP_ENROLMENT_REQUIRED', async () => {
    const app = enrolmentApp();
    const token = signAccessToken('adm_1', ['ADMIN'], 'ses_1', { perms: [], mustEnrolAuthenticator: true });
    expect((await request(app).get('/api/v1/users/me').set(bearer(token))).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/2fa/totp/enrol').set(bearer(token))).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/2fa/totp/confirm').set(bearer(token))).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/2fa/status?x=1').set(bearer(token))).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/logout').set(bearer(token))).status).toBe(200);

    for (const [method, path] of [['get', '/api/v1/orders'], ['post', '/api/v1/users'], ['get', '/api/v1/users/me/sessions']] as const) {
      const res = await request(app)[method](path).set(bearer(token));
      expect(res.status, path).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'TOTP_ENROLMENT_REQUIRED' } });
    }
  });

  /* M-B: the allowlist names a method with each path. */
  it('matches the method too — PATCH /users/me and a GET of the enrol path are not on the list', async () => {
    const app = enrolmentApp();
    const token = signAccessToken('adm_1', ['ADMIN'], 'ses_1', { perms: [], mustEnrolAuthenticator: true });
    for (const [method, path] of [['patch', '/api/v1/users/me'], ['get', '/api/v1/auth/2fa/totp/enrol']] as const) {
      const res = await request(app)[method](path).set(bearer(token));
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toMatchObject({ error: { code: 'TOTP_ENROLMENT_REQUIRED' } });
    }
    expect(ENROLMENT_ONLY_PATHS).toEqual([
      { method: 'POST', path: '/auth/2fa/totp/enrol' },
      { method: 'POST', path: '/auth/2fa/totp/confirm' },
      { method: 'GET', path: '/auth/2fa/status' },
      { method: 'POST', path: '/auth/logout' },
      { method: 'GET', path: '/users/me' },
    ]);
  });

  it('costs an ordinary session nothing — a token without the claim opens every route', async () => {
    const app = enrolmentApp();
    const token = signAccessToken('adm_1', ['ADMIN'], 'ses_1', { perms: [] });
    expect((await request(app).get('/api/v1/orders').set(bearer(token))).status).toBe(200);
    expect((await request(app).post('/api/v1/users').set(bearer(token))).status).toBe(200);
  });
});
