import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * K-B1 — the admin editor, the create, the detail read and the list facets.
 *
 * What is pinned: `language` and `avatarUrl` ride beside the four; a mobile
 * or email that collides with another account's primary or with any contact
 * row is 409 CONTACT_TAKEN saying which; moving an email needs a reason like
 * moving a number does; every edit writes one USER_UPDATED_BY_ADMIN row with
 * the diff; POST /users refuses a taken identity and is audited
 * USER_CREATED_BY_ADMIN; GET /users/:id carries the roles, counts, stamps
 * and party links; GET /users answers the array it always did with the
 * per-state counts beside it, and `q` reaches the contact rows.
 */
const { repository, auth, accessControl, audit } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findWithRoles: vi.fn(),
    replaceRoles: vi.fn(),
    ensureAgentProfile: vi.fn(),
    findByMobile: vi.fn(),
    findByEmail: vi.fn(),
    findContactByValue: vi.fn(),
    updateByAdmin: vi.fn(),
    updateProfile: vi.fn(),
    createWithRoles: vi.fn(),
    findProfile: vi.fn(),
    findAdminDetail: vi.fn(),
    findAllForAdmin: vi.fn(),
    countByState: vi.fn(),
  },
  auth: {
    normalizeMobile: vi.fn((m: string) => m),
    revokeSessions: vi.fn(),
    expireOutstandingOtpsForUser: vi.fn(),
    requireTwoFactorFor: vi.fn(),
    listActiveSessions: vi.fn(),
    sendPasswordResetLink: vi.fn(),
    revokeOtherSessions: vi.fn(),
    revokeSessionById: vi.fn(),
    resetEmailOtpFallback: vi.fn(),
    createInvite: vi.fn(),
    inviteSchema: {},
    listInvites: vi.fn(),
    resendInvite: vi.fn(),
    revokeInvite: vi.fn(),
    /* Lot K2: the enrolment on the admin reads, and the desk's reset. */
    authenticatorStatus: vi.fn(),
    clearAuthenticator: vi.fn(),
    recoveryCodesLeftFor: vi.fn(),
  },
  accessControl: { getRoleConfigForUser: vi.fn(), assignRoleConfig: vi.fn(), assignRoleConfigSchema: {}, assertNotLastSuperAdmin: vi.fn(), consoleStandingFor: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})), listActivity: vi.fn() },
}));

vi.mock('../prisma-users.repository', async (importActual) => {
  // The where-clause builder is pure; the rest is the mock.
  const actual = await importActual<typeof import('../prisma-users.repository')>();
  return { prismaUsersRepository: repository, adminListWhere: actual.adminListWhere };
});
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));
vi.mock('../onboarding-manifest.service', () => ({ onboardingManifest: vi.fn() }));
vi.mock('../preferences', () => ({ getPreferencesView: vi.fn(), savePreferencesSchema: {}, saveUserPreferences: vi.fn() }));

import { createUser as createUserService, updateProfile, updateUserByAdmin } from '../users.service';
import { createUser, getAllUsers, getUserById, resetTwoFactorFallback, updateUserByAdmin as updateUserByAdminHandler } from '../users.controller';
import { adminListWhere } from '../prisma-users.repository';
import { updateUserByAdminSchema } from '../users.schema';

const NOW = new Date('2026-09-14T10:00:00Z');

const target = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919845012210',
  email: 'asha@adx.co',
  name: 'Asha',
  language: 'en',
  avatarUrl: null,
  isActive: true,
  closedAt: null,
  closeReason: null,
  createdAt: NOW,
  lastLoginAt: NOW,
  twoFactorRequiredAt: null,
  totpSecretEnc: null,
  totpEnrolledAt: null,
  emailUnsubscribedAt: null,
  passwordHash: null,
  roles: [{ role: 'PUBLISHER' }],
  agentProfile: null,
  publisherProfile: { id: 'pub_1', displayId: 'PUB-1' },
  advertiserProfile: null,
  ...over,
});

const request = (over: Record<string, unknown> = {}) =>
  ({ params: { id: 'usr_1' }, body: {}, query: {}, user: { sub: 'adm_1' }, ip: '127.0.0.1', headers: {}, method: 'PATCH', ...over }) as never;

const response = () => {
  const res: Record<string, unknown> = {};
  res['status'] = vi.fn(() => res);
  res['json'] = vi.fn(() => res);
  return res as never as { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithRoles.mockResolvedValue(target());
  repository.findById.mockResolvedValue(target());
  repository.findByMobile.mockResolvedValue(null);
  repository.findByEmail.mockResolvedValue(null);
  repository.findContactByValue.mockResolvedValue(null);
  repository.updateByAdmin.mockImplementation(async (_id: string, data: Record<string, unknown>) => target(data));
  repository.replaceRoles.mockResolvedValue(undefined);
  repository.ensureAgentProfile.mockResolvedValue(undefined);
  repository.updateProfile.mockImplementation(async (_id: string, data: Record<string, unknown>) => target(data));
  repository.createWithRoles.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'usr_new', ...data }));
  repository.findProfile.mockResolvedValue(target());
  repository.findAdminDetail.mockResolvedValue({
    contactsCount: 2,
    publisher: { id: 'pub_1', displayId: 'PUB-1' },
    advertiser: null,
    agent: null,
    printPartner: { id: 'prt_1', displayId: 'PRT-1' },
  });
  repository.findAllForAdmin.mockResolvedValue([]);
  repository.countByState.mockResolvedValue({ ACTIVE: 3, INACTIVE: 1, CLOSED: 2 });
  accessControl.getRoleConfigForUser.mockResolvedValue({ id: 'rc_1', name: 'Finance' });
  auth.listActiveSessions.mockResolvedValue([{ id: 'ses_1' }, { id: 'ses_2' }]);
  auth.authenticatorStatus.mockResolvedValue({ enrolled: false, enrolledAt: null, recoveryCodesLeft: 0 });
  auth.recoveryCodesLeftFor.mockResolvedValue(new Map());
  auth.clearAuthenticator.mockResolvedValue({ hadAuthenticator: false, recoveryCodesCleared: 0 });
  auth.resetEmailOtpFallback.mockResolvedValue(undefined);
  audit.auditDiff.mockImplementation(((before: Record<string, unknown>, after: Record<string, unknown>, fields?: string[]) => {
    const diff: Record<string, unknown> = {};
    for (const key of fields ?? Object.keys(after ?? {})) if (before?.[key] !== after?.[key]) diff[key] = { before: before?.[key] ?? null, after: after?.[key] ?? null };
    return diff;
  }) as never);
});

describe('PATCH /users/:id', () => {
  it('takes language and avatarUrl beside the rest', () => {
    const parsed = updateUserByAdminSchema.safeParse({ language: 'hi', avatarUrl: 'https://cdn.adx.co/a.png', name: 'Asha Rao' });
    expect(parsed.success).toBe(true);
    expect(updateUserByAdminSchema.safeParse({ avatarUrl: null }).success).toBe(true);
    expect(updateUserByAdminSchema.safeParse({ avatarUrl: 'not a url' }).success).toBe(false);
  });

  it('writes them through and answers the diff of what changed', async () => {
    const { user, diff, movedIdentity } = await updateUserByAdmin('usr_1', 'adm_1', { language: 'hi', avatarUrl: 'https://cdn.adx.co/a.png' });
    expect(repository.updateByAdmin).toHaveBeenCalledWith('usr_1', { language: 'hi', avatarUrl: 'https://cdn.adx.co/a.png' });
    expect(user.id).toBe('usr_1');
    expect(diff).toEqual({ language: { before: 'en', after: 'hi' }, avatarUrl: { before: null, after: 'https://cdn.adx.co/a.png' } });
    expect(movedIdentity).toEqual([]);
  });

  it('moving the email needs a reason, lower-cases it, and reports it as a moved identity', async () => {
    await expect(updateUserByAdmin('usr_1', 'adm_1', { email: 'New@ADX.co' })).rejects.toMatchObject({ statusCode: 400 });
    const { movedIdentity } = await updateUserByAdmin('usr_1', 'adm_1', { email: 'New@ADX.co', reason: 'changed employer, asked on a call' });
    expect(repository.updateByAdmin).toHaveBeenCalledWith('usr_1', { email: 'new@adx.co' });
    expect(movedIdentity).toEqual(['email']);
  });

  it('an unchanged email is no change at all, so no reason is asked', async () => {
    await expect(updateUserByAdmin('usr_1', 'adm_1', { email: 'asha@adx.co', name: 'Asha R' })).resolves.toBeTruthy();
    expect(repository.findByEmail).not.toHaveBeenCalled();
  });

  it("409 CONTACT_TAKEN with which — another account's primary email", async () => {
    repository.findByEmail.mockResolvedValue(target({ id: 'usr_2' }));
    await expect(updateUserByAdmin('usr_1', 'adm_1', { email: 'taken@adx.co', reason: 'a good reason here' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'PRIMARY', userId: 'usr_2', kind: 'EMAIL' },
    });
  });

  it("409 CONTACT_TAKEN with which — a contact row, the target's own included", async () => {
    repository.findContactByValue.mockResolvedValue({ id: 'ct_5', userId: 'usr_1', kind: 'PHONE', value: '+919000000005' });
    await expect(updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000005', reason: 'a good reason here' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'CONTACT', userId: 'usr_1', contactId: 'ct_5' },
    });
    expect(repository.updateByAdmin).not.toHaveBeenCalled();
  });

  it('the handler writes one USER_UPDATED_BY_ADMIN row with the diff, the actor, the fields and the outcome', async () => {
    const res = response();
    await updateUserByAdminHandler(request({ body: { name: 'Asha Rao', isActive: false } }), res as never);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_UPDATED_BY_ADMIN',
      expect.objectContaining({
        targetType: 'User',
        targetId: 'usr_1',
        diff: { name: { before: 'Asha', after: 'Asha Rao' }, isActive: { before: true, after: false } },
        metadata: { updatedBy: 'adm_1', fields: ['name', 'isActive'], outcome: 'ACCOUNT_DEACTIVATED' },
      }),
    );
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'ACCOUNT_DEACTIVATED');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 'usr_1', name: 'Asha Rao', isActive: false }) });
  });

  it('carries the reason and the moved identity on the row when an identity moved', async () => {
    await updateUserByAdminHandler(request({ body: { email: 'new@adx.co', reason: 'changed employer, asked on a call' } }), response() as never);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'USER_UPDATED_BY_ADMIN',
      expect.objectContaining({ metadata: expect.objectContaining({ movedIdentity: ['email'], reason: 'changed employer, asked on a call' }) }),
    );
  });
});

/* M-B: the admin editor's roles patch, and the last super admin who cannot lose ADMIN through it. */
describe('PATCH /users/:id { roles }', () => {
  const superAdmin = () => target({ id: 'adm_1', roles: [{ role: 'ADMIN' }], twoFactorRequiredAt: NOW });

  it('takes the whole list, upper-cased, at least one', () => {
    expect(updateUserByAdminSchema.safeParse({ roles: ['admin', 'publisher'] }).success).toBe(true);
    expect(updateUserByAdminSchema.safeParse({ roles: [] }).success).toBe(false);
    expect(updateUserByAdminSchema.safeParse({ roles: ['KING'] }).success).toBe(false);
  });

  it('refuses 409 LAST_SUPER_ADMIN when the patch drops ADMIN from the last active super admin, before anything is written', async () => {
    repository.findWithRoles.mockResolvedValue(superAdmin());
    accessControl.assertNotLastSuperAdmin.mockImplementationOnce(async (_userId: string, action: string) => {
      if (action === 'DEMOTE') throw Object.assign(new Error('The last active member of the super-admin role cannot be demoted.'), { statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    });
    await expect(updateUserByAdmin('adm_1', 'adm_2', { roles: ['PUBLISHER'] })).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    expect(accessControl.assertNotLastSuperAdmin).toHaveBeenCalledWith('adm_1', 'DEMOTE');
    expect(repository.replaceRoles).not.toHaveBeenCalled();
    expect(repository.updateByAdmin).not.toHaveBeenCalled();
    expect(accessControl.assignRoleConfig).not.toHaveBeenCalled();
    expect(auth.revokeSessions).not.toHaveBeenCalled();
  });

  it('a patch that keeps ADMIN, or changes nothing, never asks the super-admin rule', async () => {
    repository.findWithRoles.mockResolvedValue(superAdmin());
    await updateUserByAdmin('adm_1', 'adm_2', { roles: ['ADMIN', 'PARTNER'] });
    await updateUserByAdmin('adm_1', 'adm_2', { roles: ['ADMIN'] });
    await updateUserByAdmin('adm_1', 'adm_2', { name: 'Asha R' });
    expect(accessControl.assertNotLastSuperAdmin).not.toHaveBeenCalled();
    expect(repository.replaceRoles).toHaveBeenCalledTimes(1);
    expect(repository.replaceRoles).toHaveBeenCalledWith('adm_1', ['ADMIN', 'PARTNER']);
  });

  it('dropping ADMIN from somebody the rule allows clears the console role first, replaces the rows and ends the sessions', async () => {
    repository.findWithRoles.mockResolvedValue(superAdmin());
    repository.updateByAdmin.mockResolvedValue(target({ id: 'adm_1', roles: [{ role: 'PARTNER' }] }));
    accessControl.getRoleConfigForUser.mockResolvedValue({ id: 'rc_1', name: 'Finance' });
    accessControl.assignRoleConfig.mockResolvedValue({ userId: 'adm_1', roleConfig: null, previous: { id: 'rc_1', name: 'Finance' } });
    const { diff } = await updateUserByAdmin('adm_1', 'adm_2', { roles: ['PARTNER'] });
    expect(accessControl.assertNotLastSuperAdmin).toHaveBeenCalledWith('adm_1', 'DEMOTE');
    expect(accessControl.assignRoleConfig).toHaveBeenCalledWith('adm_1', 'adm_2', { roleConfigId: null });
    expect(repository.replaceRoles).toHaveBeenCalledWith('adm_1', ['PARTNER']);
    expect(auth.revokeSessions).toHaveBeenCalledWith('adm_1', 'ROLES_CHANGED');
    expect(auth.requireTwoFactorFor).not.toHaveBeenCalled();
    expect(diff['roles']).toEqual({ before: ['ADMIN'], after: ['PARTNER'] });
  });

  it('granting ADMIN turns the second factor on; an agent role gets its profile', async () => {
    repository.updateByAdmin.mockResolvedValue(target({ roles: [{ role: 'PUBLISHER' }, { role: 'ADMIN' }, { role: 'AGENT_PUBLISHER' }] }));
    await updateUserByAdmin('usr_1', 'adm_1', { roles: ['PUBLISHER', 'ADMIN', 'AGENT_PUBLISHER', 'AGENT_PUBLISHER'] });
    expect(repository.replaceRoles).toHaveBeenCalledWith('usr_1', ['PUBLISHER', 'ADMIN', 'AGENT_PUBLISHER']);
    expect(auth.requireTwoFactorFor).toHaveBeenCalledWith('usr_1');
    expect(repository.ensureAgentProfile).toHaveBeenCalledWith('usr_1');
    expect(accessControl.assignRoleConfig).not.toHaveBeenCalled();
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'ROLES_CHANGED');
  });
});

describe('POST /users', () => {
  it('refuses a taken mobile or email, primary or contact', async () => {
    repository.findByMobile.mockResolvedValue(target({ id: 'usr_2' }));
    await expect(createUserService({ mobile: '+919845012210', roles: ['PUBLISHER'] })).rejects.toMatchObject({ statusCode: 409, code: 'CONTACT_TAKEN' });
    repository.findByMobile.mockResolvedValue(null);
    repository.findContactByValue.mockResolvedValue({ id: 'ct_1', userId: 'usr_9', kind: 'EMAIL', value: 'x@adx.co' });
    await expect(createUserService({ mobile: '+919000000000', email: 'x@adx.co', roles: ['PUBLISHER'] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'CONTACT', userId: 'usr_9' },
    });
    expect(repository.createWithRoles).not.toHaveBeenCalled();
  });

  it('creates the person and audits USER_CREATED_BY_ADMIN against the new account', async () => {
    const res = response();
    await createUser(request({ method: 'POST', body: { mobile: '+919000000000', name: 'Ravi', email: 'Ravi@ADX.co', roles: ['publisher'] } }), res as never);
    expect(repository.createWithRoles).toHaveBeenCalledWith(expect.objectContaining({ mobile: '+919000000000', email: 'ravi@adx.co', roles: ['PUBLISHER'] }));
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_new',
      'USER_CREATED_BY_ADMIN',
      expect.objectContaining({ targetType: 'User', targetId: 'usr_new', metadata: { createdBy: 'adm_1', roles: ['PUBLISHER'], roleConfigId: null } }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(accessControl.assignRoleConfig).not.toHaveBeenCalled();
  });

  it('gives the console role in the same breath when the form named one', async () => {
    accessControl.assignRoleConfig.mockResolvedValue({ userId: 'usr_new', roleConfig: { id: 'rc_1', name: 'Finance' }, previous: null });
    await createUser(request({ method: 'POST', body: { mobile: '+919000000000', roles: ['ADMIN'], roleConfigId: 'rc_1' } }), response() as never);
    expect(accessControl.assignRoleConfig).toHaveBeenCalledWith('usr_new', 'adm_1', { roleConfigId: 'rc_1' });
    expect(auth.requireTwoFactorFor).toHaveBeenCalledWith('usr_new');
  });
});

describe('GET /users/:id', () => {
  it('carries the roles, the console role, the counts, the stamps and the party links', async () => {
    const res = response();
    await getUserById(request({ method: 'GET' }), res as never);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        id: 'usr_1',
        roles: ['PUBLISHER'],
        roleConfig: { id: 'rc_1', name: 'Finance' },
        contactsCount: 2,
        sessionsCount: 2,
        lastLoginAt: NOW,
        twoFactorRequiredAt: null,
        closedAt: null,
        // Lot K2: no second factor on a publisher account.
        twoFactor: { required: false, method: null, enrolledAt: null, recoveryCodesLeft: 0 },
        parties: {
          publisher: { id: 'pub_1', displayId: 'PUB-1' },
          advertiser: null,
          agent: null,
          printPartner: { id: 'prt_1', displayId: 'PRT-1' },
        },
      }),
    });
  });

  it('Lot K2: twoFactor names the factor the next sign-in asks for — SMS once required, AUTHENTICATOR once enrolled, with the codes left', async () => {
    repository.findProfile.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }], twoFactorRequiredAt: NOW }));
    let res = response();
    await getUserById(request({ method: 'GET' }), res as never);
    expect((res.json.mock.calls[0]![0] as { data: { twoFactor: unknown } }).data.twoFactor).toEqual({ required: true, method: 'SMS', enrolledAt: null, recoveryCodesLeft: 0 });

    repository.findProfile.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }], twoFactorRequiredAt: NOW, totpSecretEnc: 'sealed', totpEnrolledAt: NOW }));
    auth.authenticatorStatus.mockResolvedValue({ enrolled: true, enrolledAt: NOW, recoveryCodesLeft: 8 });
    res = response();
    await getUserById(request({ method: 'GET' }), res as never);
    expect((res.json.mock.calls[0]![0] as { data: { twoFactor: unknown } }).data.twoFactor).toEqual({ required: true, method: 'AUTHENTICATOR', enrolledAt: NOW, recoveryCodesLeft: 8 });
  });
});

describe('POST /users/:id/2fa/reset (Lot K2)', () => {
  it('clears the email backup, the authenticator and the recovery codes, audited with what it cleared', async () => {
    auth.clearAuthenticator.mockResolvedValue({ hadAuthenticator: true, recoveryCodesCleared: 6 });
    const res = response();
    await resetTwoFactorFallback(request({ method: 'POST' }), res as never);
    expect(auth.resetEmailOtpFallback).toHaveBeenCalledWith('usr_1');
    expect(auth.clearAuthenticator).toHaveBeenCalledWith('usr_1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'TWO_FACTOR_FALLBACK_RESET',
      expect.objectContaining({
        targetType: 'User',
        targetId: 'usr_1',
        diff: expect.objectContaining({ authenticator: { before: true, after: false }, recoveryCodes: { before: 6, after: 0 } }),
        metadata: { resetBy: 'adm_1', cleared: { emailFallback: true, authenticator: true, recoveryCodes: 6 } },
      }),
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { message: 'Email backup restored and authenticator app removed', cleared: { emailFallback: true, authenticator: true, recoveryCodes: 6 } },
    });
  });

  it('says so when there was no authenticator to clear, and 404s an unknown account', async () => {
    const res = response();
    await resetTwoFactorFallback(request({ method: 'POST' }), res as never);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { message: 'Email backup restored', cleared: { emailFallback: true, authenticator: false, recoveryCodes: 0 } },
    });
    repository.findById.mockResolvedValue(null);
    await expect(resetTwoFactorFallback(request({ method: 'POST' }), response() as never)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('GET /users', () => {
  it('keeps the array and adds the per-state counts and the total beside it', async () => {
    repository.findAllForAdmin.mockResolvedValue([target({ placedOrders: [], onboardingSubmissions: [] })]);
    const res = response();
    await getAllUsers(request({ method: 'GET', query: { q: 'work.co', state: 'ACTIVE', sort: 'name', role: 'PUBLISHER' } }), res as never);
    expect(repository.findAllForAdmin).toHaveBeenCalledWith({ closed: undefined, q: 'work.co', role: 'PUBLISHER', state: 'ACTIVE', sort: 'name' });
    // The chips are counted with the state facet removed.
    expect(repository.countByState).toHaveBeenCalledWith({ closed: undefined, q: 'work.co', role: 'PUBLISHER' });
    const payload = res.json.mock.calls[0]![0] as { data: unknown[]; counts: unknown; total: number };
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.counts).toEqual({ ACTIVE: 3, INACTIVE: 1, CLOSED: 2 });
    expect(payload.total).toBe(1);
  });

  it('Lot K2: every row carries the second-factor summary beside roleConfig and lastLoginAt, one count query for the enrolled rows', async () => {
    repository.findAllForAdmin.mockResolvedValue([
      target({ id: 'adm_1', roles: [{ role: 'ADMIN' }], twoFactorRequiredAt: NOW, totpSecretEnc: 'sealed', totpEnrolledAt: NOW, roleConfig: { roleConfig: { id: 'rc_1', name: 'Finance' } }, placedOrders: [], onboardingSubmissions: [] }),
      target({ id: 'adm_2', roles: [{ role: 'ADMIN' }], twoFactorRequiredAt: NOW, placedOrders: [], onboardingSubmissions: [] }),
      target({ placedOrders: [], onboardingSubmissions: [] }),
    ]);
    auth.recoveryCodesLeftFor.mockResolvedValue(new Map([['adm_1', 4]]));
    const res = response();
    await getAllUsers(request({ method: 'GET', query: { role: 'ADMIN' } }), res as never);
    expect(auth.recoveryCodesLeftFor).toHaveBeenCalledWith(['adm_1']);
    const rows = (res.json.mock.calls[0]![0] as { data: Record<string, unknown>[] }).data;
    expect(rows[0]).toMatchObject({ id: 'adm_1', roleConfig: { id: 'rc_1', name: 'Finance' }, lastLoginAt: NOW, twoFactor: { required: true, method: 'AUTHENTICATOR', enrolledAt: NOW, recoveryCodesLeft: 4 } });
    expect(rows[1]).toMatchObject({ id: 'adm_2', roleConfig: null, twoFactor: { required: true, method: 'SMS', enrolledAt: null, recoveryCodesLeft: 0 } });
    expect(rows[2]).toMatchObject({ id: 'usr_1', twoFactor: { required: false, method: null, enrolledAt: null, recoveryCodesLeft: 0 } });

    // No enrolled row, no count query.
    auth.recoveryCodesLeftFor.mockClear();
    repository.findAllForAdmin.mockResolvedValue([target({ placedOrders: [], onboardingSubmissions: [] })]);
    await getAllUsers(request({ method: 'GET', query: {} }), response() as never);
    expect(auth.recoveryCodesLeftFor).not.toHaveBeenCalled();
  });

  it('refuses a state or sort outside the vocabulary', async () => {
    await expect(getAllUsers(request({ method: 'GET', query: { state: 'DEAD' } }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
    await expect(getAllUsers(request({ method: 'GET', query: { sort: 'random' } }), response() as never)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('q reaches the contact rows, and the state facet cuts on closedAt and isActive', () => {
    const where = adminListWhere({ q: 'work.co', state: 'INACTIVE' });
    expect(where.OR).toContainEqual({ contacts: { some: { value: { contains: 'work.co', mode: 'insensitive' } } } });
    expect(where.OR).toContainEqual({ email: { contains: 'work.co', mode: 'insensitive' } });
    expect(where).toMatchObject({ closedAt: null, isActive: false });
    expect(adminListWhere({ state: 'CLOSED' })).toEqual({ closedAt: { not: null } });
    expect(adminListWhere({ state: 'ACTIVE' })).toEqual({ closedAt: null, isActive: true });
    expect(adminListWhere({})).toEqual({});
  });
});

/* K-B1 (verifier): the person's own profile write runs the same one-value-one-account rule as the desk's. */
describe('PATCH /users/me — the email', () => {
  it('lower-cases the address before it is written', async () => {
    await updateProfile('usr_1', { email: 'New@ADX.co', name: 'Asha R' });
    expect(repository.updateProfile).toHaveBeenCalledWith('usr_1', { email: 'new@adx.co', name: 'Asha R' });
  });

  it("409 CONTACT_TAKEN when the address is another account's contact row", async () => {
    repository.findContactByValue.mockResolvedValue({ id: 'ct_9', userId: 'usr_2', kind: 'EMAIL', value: 'x@y.co' });
    await expect(updateProfile('usr_1', { email: 'X@Y.co' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'CONTACT', userId: 'usr_2', contactId: 'ct_9' },
    });
    expect(repository.updateProfile).not.toHaveBeenCalled();
  });

  it("409 CONTACT_TAKEN when the address is another account's primary", async () => {
    repository.findByEmail.mockResolvedValue(target({ id: 'usr_2' }));
    await expect(updateProfile('usr_1', { email: 'taken@adx.co' })).rejects.toMatchObject({ statusCode: 409, code: 'CONTACT_TAKEN', details: { which: 'PRIMARY', userId: 'usr_2' } });
  });

  it('the address already on the row is no change, so nothing is looked up', async () => {
    await updateProfile('usr_1', { email: 'Asha@ADX.co' });
    expect(repository.findByEmail).not.toHaveBeenCalled();
    expect(repository.findContactByValue).not.toHaveBeenCalled();
    expect(repository.updateProfile).toHaveBeenCalledWith('usr_1', { email: 'asha@adx.co' });
  });

  it('a write with no email asks nothing', async () => {
    await updateProfile('usr_1', { name: 'Asha R' });
    expect(repository.findById).not.toHaveBeenCalled();
    expect(repository.updateProfile).toHaveBeenCalledWith('usr_1', { name: 'Asha R' });
  });
});
