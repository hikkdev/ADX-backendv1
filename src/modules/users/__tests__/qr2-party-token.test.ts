import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-2 (16 Sep 2026) — the role a party choice grants must reach the very
 * next request.
 *
 * The roles ride inside the access token. `POST /users/me/party` granted
 * PUBLISHER in the database and answered with a token that still said
 * nothing — so the publisher's own home (`GET /publishers/me`,
 * `requireRole('PUBLISHER')`) answered 403 "Insufficient permissions" until
 * the token expired, fifteen minutes later. Pinned: the route re-signs the
 * caller's SAME session with the roles as they are now and hands the token
 * back beside the choice; the reissue is asked with the session id off the
 * caller's token; a token that cannot be reissued (no session id on the
 * claim) leaves the choice as it was rather than failing it.
 */

const { service, auth, audit } = vi.hoisted(() => ({
  service: { chooseParty: vi.fn() },
  auth: { reissueAccessToken: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../users.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../users.service')>();
  return { ...actual, ...service };
});
vi.mock('../../auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth')>();
  return { ...actual, ...auth };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import jwt from 'jsonwebtoken';
import { errorHandler } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { userRouter } from '../users.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/users', userRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const choice = { party: 'PUBLISHER', accountType: 'INDIVIDUAL', profileId: 'pub_1', displayId: 'PUB-1009-2601', created: true };

beforeEach(() => {
  vi.clearAllMocks();
  service.chooseParty.mockResolvedValue(choice);
  auth.reissueAccessToken.mockResolvedValue('fresh.access.token');
});

describe('POST /users/me/party', () => {
  it('re-signs the caller\'s session with the new role and hands the token back beside the choice', async () => {
    // A brand-new number: signed in, no roles yet, session sess_1.
    const token = signAccessToken('usr_1', [], 'sess_1');
    const res = await request(app()).post('/api/v1/users/me/party').set('Authorization', `Bearer ${token}`).send({ party: 'PUBLISHER', accountType: 'INDIVIDUAL' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ ...choice, accessToken: 'fresh.access.token' });
    expect(auth.reissueAccessToken).toHaveBeenCalledWith('usr_1', 'sess_1');
    expect(service.chooseParty).toHaveBeenCalledWith('usr_1', { party: 'PUBLISHER', accountType: 'INDIVIDUAL' });
  });

  it('answers 200 and still refreshes the token when the side already existed', async () => {
    service.chooseParty.mockResolvedValue({ ...choice, created: false });
    const token = signAccessToken('usr_1', ['ADVERTISER'], 'sess_2');
    const res = await request(app()).post('/api/v1/users/me/party').set('Authorization', `Bearer ${token}`).send({ party: 'PUBLISHER', accountType: 'BUSINESS' });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBe('fresh.access.token');
    expect(auth.reissueAccessToken).toHaveBeenCalledWith('usr_1', 'sess_2');
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('a claim without a session id gets the choice without a token rather than a failure', async () => {
    // Signed the way the tokens helper does, but with no `sid` on the claim.
    const { decode } = jwt;
    const token = signAccessToken('usr_1', [], 'sess_3');
    const payload = decode(token) as Record<string, unknown>;
    delete payload.sid;
    delete payload.iat;
    delete payload.exp;
    const bare = jwt.sign(payload, process.env.JWT_ACCESS_SECRET as string, { expiresIn: '5m' });

    const res = await request(app()).post('/api/v1/users/me/party').set('Authorization', `Bearer ${bare}`).send({ party: 'PUBLISHER', accountType: 'INDIVIDUAL' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(choice);
    expect(auth.reissueAccessToken).not.toHaveBeenCalled();
  });
});
