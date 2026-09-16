import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E11-1: the account reads the phones need. `/me` and `/me/preferences` say
 * whether the person has unsubscribed from ADX's email; the person's own
 * "send them again" mirrors the public link in the other direction, audited,
 * and a 409 when there was nothing to undo; and signing out every other
 * device answers how many went.
 */
const { repository, auth, accessControl, audit } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findProfile: vi.fn(),
    findPreferences: vi.fn(),
    upsertPreference: vi.fn(),
    clearEmailUnsubscribed: vi.fn(),
  },
  auth: {
    normalizeMobile: vi.fn((m: string) => m),
    revokeSessions: vi.fn(),
    requireTwoFactorFor: vi.fn(),
    sendPasswordResetLink: vi.fn(),
    revokeOtherSessions: vi.fn(),
    listActiveSessions: vi.fn(),
    revokeSessionById: vi.fn(),
    resetEmailOtpFallback: vi.fn(),
    createInvite: vi.fn(),
    inviteSchema: {},
    listInvites: vi.fn(),
    resendInvite: vi.fn(),
    revokeInvite: vi.fn(),
  },
  accessControl: { getRoleConfigForUser: vi.fn(), assignRoleConfig: vi.fn(), assignRoleConfigSchema: {}, consoleStandingFor: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})), listActivity: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));
vi.mock('../onboarding-manifest.service', () => ({ onboardingManifest: vi.fn() }));

import { errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { authenticate, signAccessToken } from '../../../shared/auth';
import { profilePayload } from '../users.mapper';
import { resubscribeEmail } from '../users.service';
import { getPreferencesView } from '../preferences';
import { getMe, getMyPreferences, resubscribeMyEmail, revokeMyOtherSessions, saveMyPreferences } from '../users.controller';

const NOW = new Date('2026-09-12T10:00:00Z');
const UNSUBSCRIBED_AT = new Date('2026-09-01T00:00:00Z');

const user = (over: Record<string, unknown> = {}) =>
  ({
    id: 'usr_1',
    mobile: '+919845012210',
    name: 'Asha',
    email: 'asha@adx.co',
    avatarUrl: null,
    passwordHash: 'x',
    language: 'en',
    isActive: true,
    closedAt: null,
    closeReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastLoginAt: NOW,
    emailUnsubscribedAt: null,
    twoFactorRequiredAt: null,
    emailOtpFallbackCount: 0,
    emailOtpFallbackResetAt: null,
    roles: [{ role: 'PUBLISHER' }],
    agentProfile: null,
    publisherProfile: null,
    advertiserProfile: null,
    ...over,
  }) as never;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.get('/api/v1/users/me', authenticate, asyncHandler(getMe));
  instance.get('/api/v1/users/me/preferences', authenticate, asyncHandler(getMyPreferences));
  instance.put('/api/v1/users/me/preferences', authenticate, asyncHandler(saveMyPreferences));
  instance.post('/api/v1/users/me/email-resubscribe', authenticate, asyncHandler(resubscribeMyEmail));
  instance.delete('/api/v1/users/me/sessions', authenticate, asyncHandler(revokeMyOtherSessions));
  instance.use(errorHandler);
  return instance;
}

/** A party token that names its session, as a real login's does. */
const token = signAccessToken('usr_1', ['PUBLISHER'], 'ses_keep');

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(user());
  repository.findProfile.mockResolvedValue(user());
  repository.findPreferences.mockResolvedValue([]);
  repository.upsertPreference.mockResolvedValue(undefined);
  repository.clearEmailUnsubscribed.mockResolvedValue(true);
  auth.revokeOtherSessions.mockResolvedValue(2);
  accessControl.consoleStandingFor.mockResolvedValue({ roleConfig: null, isSuperAdmin: false });
});

describe('GET /users/me', () => {
  it('carries emailUnsubscribedAt, null while subscribed and the stamp once not', async () => {
    expect(profilePayload(user())).toMatchObject({ emailUnsubscribedAt: null });
    expect(profilePayload(user({ emailUnsubscribedAt: UNSUBSCRIBED_AT }))).toMatchObject({ emailUnsubscribedAt: UNSUBSCRIBED_AT });

    repository.findProfile.mockResolvedValue(user({ emailUnsubscribedAt: UNSUBSCRIBED_AT }));
    const res = await request(app()).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.emailUnsubscribedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  /* M-B: the console standing rides on /me, by access-control's predicate. */
  it('carries roleConfig { id, name, isSystem } and isSuperAdmin from access-control, asked with the roles held', async () => {
    const party = await request(app()).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(party.status).toBe(200);
    expect(party.body.data).toMatchObject({ roleConfig: null, isSuperAdmin: false });
    expect(accessControl.consoleStandingFor).toHaveBeenCalledWith('usr_1', ['PUBLISHER']);

    repository.findProfile.mockResolvedValue(user({ roles: [{ role: 'ADMIN' }] }));
    accessControl.consoleStandingFor.mockResolvedValue({ roleConfig: { id: 'rc_super', name: 'Super admin', isSystem: true }, isSuperAdmin: true });
    const admin = await request(app()).get('/api/v1/users/me').set('Authorization', `Bearer ${signAccessToken('usr_1', ['ADMIN'], 'ses_keep')}`);
    expect(admin.status).toBe(200);
    expect(admin.body.data).toMatchObject({ roleConfig: { id: 'rc_super', name: 'Super admin', isSystem: true }, isSuperAdmin: true });
    expect(accessControl.consoleStandingFor).toHaveBeenLastCalledWith('usr_1', ['ADMIN']);
  });
});

describe('GET /users/me/preferences', () => {
  it('carries emailUnsubscribedAt beside every preference key', async () => {
    repository.findById.mockResolvedValue(user({ emailUnsubscribedAt: UNSUBSCRIBED_AT }));
    const view = await getPreferencesView('usr_1');
    expect(view['app.theme']).toBe('system');
    expect(view.emailUnsubscribedAt).toEqual(UNSUBSCRIBED_AT);

    const res = await request(app()).get('/api/v1/users/me/preferences').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ 'app.theme': 'system', emailUnsubscribedAt: '2026-09-01T00:00:00.000Z' });
  });

  it('reads null while subscribed, and the same field rides on the save answer', async () => {
    const res = await request(app()).put('/api/v1/users/me/preferences').set('Authorization', `Bearer ${token}`).send({ 'app.theme': 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('emailUnsubscribedAt', null);
    expect(repository.upsertPreference).toHaveBeenCalledWith('usr_1', 'app.theme', 'dark');
  });
});

describe('POST /users/me/email-resubscribe', () => {
  it('clears the stamp, audits USER_EMAIL_RESUBSCRIBED and answers the cleared field', async () => {
    const res = await request(app()).post('/api/v1/users/me/email-resubscribe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { emailUnsubscribedAt: null } });
    expect(repository.clearEmailUnsubscribed).toHaveBeenCalledWith('usr_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'USER_EMAIL_RESUBSCRIBED', expect.anything(), expect.objectContaining({ userId: 'usr_1' }));
  });

  it('409s when the person was not unsubscribed, and audits nothing', async () => {
    repository.clearEmailUnsubscribed.mockResolvedValue(false);
    await expect(resubscribeEmail('usr_1')).rejects.toMatchObject({ statusCode: 409, code: 'NOT_UNSUBSCRIBED' });
    const res = await request(app()).post('/api/v1/users/me/email-resubscribe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    expect((await request(app()).post('/api/v1/users/me/email-resubscribe')).status).toBe(401);
  });
});

describe('DELETE /users/me/sessions', () => {
  it('answers { revoked: number } — how many other sessions were ended', async () => {
    const res = await request(app()).delete('/api/v1/users/me/sessions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { revoked: 2 } });
    expect(typeof res.body.data.revoked).toBe('number');
    expect(auth.revokeOtherSessions).toHaveBeenCalledWith('usr_1', 'ses_keep');
  });

  it('answers zero when this was the only device', async () => {
    auth.revokeOtherSessions.mockResolvedValue(0);
    const res = await request(app()).delete('/api/v1/users/me/sessions').set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toEqual({ revoked: 0 });
  });
});
