import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6: the account reads and the two desk actions the console asked for — the
 * list's search and role facets with the console role on each row, the
 * account facts on the profile payload, the second-factor state on /me, the
 * actor labels, the reset link from the desk (409 without an email) and
 * signing out every other device.
 */
const { repository, auth, accessControl, audit } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findAllForAdmin: vi.fn(),
    findNamesByIds: vi.fn(),
    findSummariesByIds: vi.fn(),
    findProfile: vi.fn(),
    ensureSystemUser: vi.fn(),
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
  accessControl: { getRoleConfigForUser: vi.fn(), assignRoleConfig: vi.fn(), assignRoleConfigSchema: {} },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})), listActivity: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));
vi.mock('../onboarding-manifest.service', () => ({ onboardingManifest: vi.fn() }));
vi.mock('../preferences', () => ({ getUserPreferences: vi.fn(), savePreferencesSchema: {}, saveUserPreferences: vi.fn() }));

import { findUserLabels, findUserSummaries, listUsersForAdmin, primaryRoleOf, sendResetLinkByAdmin } from '../users.service';
import { adminListPayload, profilePayload, twoFactorState } from '../users.mapper';
import { revokeMyOtherSessions, listUserSessions, sendResetLink } from '../users.controller';

const NOW = new Date('2026-09-12T10:00:00Z');

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
    twoFactorRequiredAt: NOW,
    emailOtpFallbackCount: 2,
    emailOtpFallbackResetAt: null,
    roles: [{ role: 'ADMIN' }],
    agentProfile: null,
    publisherProfile: null,
    advertiserProfile: null,
    placedOrders: [],
    onboardingSubmissions: [],
    ...over,
  }) as never;

const response = () => {
  const res: Record<string, unknown> = {};
  res['status'] = vi.fn(() => res);
  res['json'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAllForAdmin.mockResolvedValue([]);
  repository.findById.mockResolvedValue(user());
});

describe('GET /users', () => {
  it('passes q and role through and names the console role on each row', async () => {
    await listUsersForAdmin({ q: 'asha', role: 'ADMIN', closed: false });
    expect(repository.findAllForAdmin).toHaveBeenCalledWith({ q: 'asha', role: 'ADMIN', closed: false });

    expect(adminListPayload(user({ roleConfig: { roleConfig: { id: 'rc_1', name: 'Finance' } } })).roleConfig).toEqual({ id: 'rc_1', name: 'Finance' });
    expect(adminListPayload(user({ roleConfig: null })).roleConfig).toBeNull();
    expect(adminListPayload(user()).roleConfig).toBeNull();
  });
});

describe('GET /users/:id and /users/me', () => {
  it('carries the account facts on the profile, and the second-factor state on /me only', () => {
    const profile = profilePayload(user());
    expect(profile).toMatchObject({ isActive: true, createdAt: NOW, lastLoginAt: NOW });
    expect(profile).not.toHaveProperty('twoFactorRequiredAt');
    expect(twoFactorState(user())).toEqual({ twoFactorRequiredAt: NOW, emailOtpFallbackCount: 2, emailOtpFallbackResetAt: null });
  });
});

describe('E7-3: findUserSummaries', () => {
  it('names the person with their primary role, party roles ahead of ADMIN', async () => {
    repository.findSummariesByIds.mockResolvedValue([
      { id: 'usr_1', name: 'Asha', mobile: '+911', email: null, isActive: true, createdAt: new Date(), roles: [{ role: 'ADMIN' }, { role: 'PUBLISHER' }] },
      { id: 'usr_2', name: null, mobile: '+912', email: 'a@b.c', isActive: true, createdAt: new Date(), roles: [] },
    ]);
    const out = await findUserSummaries(['usr_1', 'usr_2', 'usr_1', 'ghost', '']);
    expect(repository.findSummariesByIds).toHaveBeenCalledWith(['usr_1', 'usr_2', 'ghost']);
    expect(out.get('usr_1')).toMatchObject({ name: 'Asha', role: 'PUBLISHER', roles: ['ADMIN', 'PUBLISHER'] });
    expect(out.get('usr_2')).toMatchObject({ role: null, roles: [] });
    expect(out.has('ghost')).toBe(false);
    expect(primaryRoleOf(['AGENT_PUBLISHER', 'ADMIN'])).toBe('AGENT_PUBLISHER');
  });

  it('skips the query for no ids', async () => {
    expect((await findUserSummaries([])).size).toBe(0);
    expect(repository.findSummariesByIds).not.toHaveBeenCalled();
  });
});

describe('findUserLabels', () => {
  it('answers every id asked for, the name or the mobile, null for a stranger', async () => {
    repository.findNamesByIds.mockResolvedValue([
      { id: 'usr_1', name: 'Asha', mobile: '+91' },
      { id: 'usr_2', name: null, mobile: '+919000000000' },
    ]);
    const labels = await findUserLabels(['usr_1', 'usr_2', 'usr_1', 'ghost', '']);
    expect(repository.findNamesByIds).toHaveBeenCalledWith(['usr_1', 'usr_2', 'ghost']);
    expect(labels.get('usr_1')).toEqual({ id: 'usr_1', name: 'Asha' });
    expect(labels.get('usr_2')).toEqual({ id: 'usr_2', name: '+919000000000' });
    expect(labels.get('ghost')).toEqual({ id: 'ghost', name: null });
    expect(labels.size).toBe(3);
  });

  it('never queries for nothing', async () => {
    await findUserLabels([]);
    expect(repository.findNamesByIds).not.toHaveBeenCalled();
  });
});

describe('POST /users/:id/reset-password', () => {
  it('sends the ordinary reset link and audits it against the account', async () => {
    const req = { params: { id: 'usr_1' }, user: { sub: 'adm_1' }, ip: '127.0.0.1', headers: {} } as never;
    const res = response();
    await sendResetLink(req, res as never);
    expect(auth.sendPasswordResetLink).toHaveBeenCalledWith('usr_1', 'asha@adx.co');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'PASSWORD_RESET_SENT_BY_ADMIN',
      expect.objectContaining({ targetType: 'User', targetId: 'usr_1', metadata: { sentBy: 'adm_1', email: 'asha@adx.co' } }),
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { message: 'Reset link sent', email: 'asha@adx.co' } });
  });

  it('409s an account with no email, and sends nothing', async () => {
    repository.findById.mockResolvedValue(user({ email: null }));
    await expect(sendResetLinkByAdmin('usr_1')).rejects.toMatchObject({ statusCode: 409, code: 'NO_EMAIL' });
    expect(auth.sendPasswordResetLink).not.toHaveBeenCalled();
  });

  it('404s an account that is not there', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(sendResetLinkByAdmin('usr_x')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('DELETE /users/me/sessions', () => {
  it('ends every other session and keeps the one the token names', async () => {
    auth.revokeOtherSessions.mockResolvedValue(3);
    const req = { user: { sub: 'usr_1', sid: 'ses_keep' }, ip: '127.0.0.1', headers: {} } as never;
    const res = response();
    await revokeMyOtherSessions(req, res as never);
    expect(auth.revokeOtherSessions).toHaveBeenCalledWith('usr_1', 'ses_keep');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { revoked: 3 } });
  });

  it('refuses a token that names no session, rather than signing the caller out too', async () => {
    const req = { user: { sub: 'usr_1' }, ip: '127.0.0.1', headers: {} } as never;
    await expect(revokeMyOtherSessions(req, response() as never)).rejects.toMatchObject({ statusCode: 409 });
    expect(auth.revokeOtherSessions).not.toHaveBeenCalled();
  });
});

describe('GET /users/:id/sessions', () => {
  it('is the /me shape with current always false', async () => {
    auth.listActiveSessions.mockResolvedValue([{ id: 'ses_1', userAgent: 'x', ipAddress: null, lastUsedAt: NOW, createdAt: NOW, expiresAt: NOW }]);
    const req = { params: { id: 'usr_1' }, user: { sub: 'adm_1', sid: 'ses_1' } } as never;
    const res = response();
    await listUserSessions(req, res as never);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [expect.objectContaining({ id: 'ses_1', current: false })] });
  });
});

/* E6: the system account the jobs write under. */
describe('the system user', () => {
  it('is created once, inactive and roleless, and its id is what a job asks for', async () => {
    const { ensureSystemUser, resetSystemUserCache, systemUserId, SYSTEM_USER_MOBILE, SYSTEM_USER_NAME } = await import('../users.service');
    const prisma = (await import('../prisma-users.repository')).prismaUsersRepository as unknown as { ensureSystemUser: ReturnType<typeof vi.fn> };
    resetSystemUserCache();
    prisma.ensureSystemUser.mockResolvedValue({ id: 'usr_system' });

    await expect(ensureSystemUser()).resolves.toBe('usr_system');
    expect(prisma.ensureSystemUser).toHaveBeenCalledWith({ mobile: SYSTEM_USER_MOBILE, name: SYSTEM_USER_NAME });
    expect(SYSTEM_USER_MOBILE).toBe('+910000000000');
    expect(SYSTEM_USER_NAME).toBe('ADX system');

    // Cached after boot: a job's ask does not hit the database again.
    await expect(systemUserId()).resolves.toBe('usr_system');
    expect(prisma.ensureSystemUser).toHaveBeenCalledTimes(1);

    // Boot did not run here: the first ask creates or finds it; a database that is down answers null.
    resetSystemUserCache();
    prisma.ensureSystemUser.mockRejectedValueOnce(new Error('down'));
    await expect(systemUserId()).resolves.toBeNull();
  });
});
