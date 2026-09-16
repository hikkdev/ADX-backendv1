import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A — what the desk may do to another account.
 *
 * What is pinned: an admin's number is never moved from the desk; anybody
 * else's needs a reason and ends their sessions; deactivating ends them too;
 * creating or granting ADMIN turns the second factor on; and impersonation is
 * read-only, bounded, never of another admin, and always carries a reason.
 */
const { repository, auth, accessControl, audit, publishers, advertisers } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findWithRoles: vi.fn(),
    findByMobile: vi.fn(),
    findByEmail: vi.fn(),
    updateByAdmin: vi.fn(),
    createWithRoles: vi.fn(),
    grantRole: vi.fn(),
    ensureAgentProfile: vi.fn(),
    findProfile: vi.fn(),
    /* K-B1: the identity-free rule reads contact rows too; the detail read joins the party links. */
    findContactByValue: vi.fn(),
    findAdminDetail: vi.fn(),
  },
  auth: {
    normalizeMobile: vi.fn((m: string) => m),
    revokeSessions: vi.fn(),
    expireOutstandingOtpsForUser: vi.fn(),
    requireTwoFactorFor: vi.fn(),
  },
  accessControl: { getRoleConfigForUser: vi.fn(), assertNotLastSuperAdmin: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  publishers: { registerPublisher: vi.fn() },
  advertisers: { registerAdvertiser: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);

import { assignRole, createUser, getUserForAdmin, updateUserByAdmin } from '../users.service';

const target = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919845012210',
  email: 'asha@adx.co',
  isActive: true,
  roles: [{ role: 'PUBLISHER' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.revokeSessions.mockResolvedValue(undefined);
  auth.requireTwoFactorFor.mockResolvedValue(undefined);
  repository.findWithRoles.mockResolvedValue(target());
  repository.findByMobile.mockResolvedValue(null);
  repository.findByEmail.mockResolvedValue(null);
  repository.findContactByValue.mockResolvedValue(null);
  repository.findAdminDetail.mockResolvedValue({ contactsCount: 0, publisher: null, advertiser: null, agent: null, printPartner: null });
  repository.updateByAdmin.mockImplementation(async (_id: string, data: Record<string, unknown>) => target(data));
  repository.createWithRoles.mockResolvedValue({ id: 'usr_new' });
  repository.findProfile.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }] }));
  accessControl.getRoleConfigForUser.mockResolvedValue({ id: 'rc_1', name: 'Finance' });
  accessControl.assertNotLastSuperAdmin.mockResolvedValue(undefined);
});

describe('moving the number somebody signs in with', () => {
  it('refuses outright when the target is an admin — that flow is self-service', async () => {
    repository.findWithRoles.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }] }));
    await expect(updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000', reason: 'they asked on the phone' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'USE_SELF_SERVICE_FLOW',
    });
    expect(repository.updateByAdmin).not.toHaveBeenCalled();
  });

  it('needs a reason for anybody else', async () => {
    await expect(updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000' })).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.updateByAdmin).not.toHaveBeenCalled();
  });

  it('writes it, ends every session and logs the change with its reason', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000', reason: 'lost the SIM, verified on a call' });
    expect(repository.updateByAdmin).toHaveBeenCalledWith('usr_1', { mobile: '+919000000000' });
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'MOBILE_CHANGED_BY_ADMIN');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_1',
      'MOBILE_CHANGED_BY_ADMIN',
      expect.objectContaining({ metadata: { changedBy: 'adm_1', reason: 'lost the SIM, verified on a call' } }),
    );
  });

  it('K-B1: expires every live code the account holds — a LOGIN code already sent to the old number cannot still sign in', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000', reason: 'lost the SIM, verified on a call' });
    expect(auth.expireOutstandingOtpsForUser).toHaveBeenCalledWith('usr_1');
  });

  it('K-B1: a code sweep that fails does not undo a swap that took', async () => {
    auth.expireOutstandingOtpsForUser.mockRejectedValueOnce(new Error('db away'));
    await expect(updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000', reason: 'lost the SIM, verified on a call' })).resolves.toBeTruthy();
    expect(audit.logActivity).toHaveBeenCalledWith('usr_1', 'MOBILE_CHANGED_BY_ADMIN', expect.anything());
  });

  it('is not a change at all when the number is the one already on the row', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919845012210' });
    expect(auth.revokeSessions).not.toHaveBeenCalled();
    expect(auth.expireOutstandingOtpsForUser).not.toHaveBeenCalled();
    expect(repository.findByMobile).not.toHaveBeenCalled();
  });

  it('still refuses a number somebody else has — K-B1: 409 CONTACT_TAKEN, saying whose', async () => {
    repository.findByMobile.mockResolvedValue({ id: 'usr_2' });
    await expect(updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000', reason: 'a good reason here' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTACT_TAKEN',
      details: { which: 'PRIMARY', userId: 'usr_2' },
    });
  });

  it('never lets the reason reach the row', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { mobile: '+919000000000', reason: 'lost the SIM, verified on a call' });
    const [, data] = repository.updateByAdmin.mock.calls[0] as [string, Record<string, unknown>];
    expect(data).not.toHaveProperty('reason');
  });
});

describe('deactivating an account', () => {
  it('ends the sessions, because an access token outlives the flag otherwise', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { isActive: false });
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'ACCOUNT_DEACTIVATED');
  });

  it('leaves them alone when the edit was something else', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { name: 'Asha Rao' });
    expect(auth.revokeSessions).not.toHaveBeenCalled();
  });

  it('still refuses an admin deactivating themselves, and a 404 target', async () => {
    await expect(updateUserByAdmin('adm_1', 'adm_1', { isActive: false })).rejects.toMatchObject({ statusCode: 400 });
    repository.findWithRoles.mockResolvedValue(null);
    await expect(updateUserByAdmin('usr_1', 'adm_1', { name: 'X' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('Lot K2: asks access-control before deactivating — the last active super admin is 409 LAST_SUPER_ADMIN and nothing is written', async () => {
    await updateUserByAdmin('usr_1', 'adm_1', { isActive: false });
    expect(accessControl.assertNotLastSuperAdmin).toHaveBeenCalledWith('usr_1', 'DEACTIVATE');

    accessControl.assertNotLastSuperAdmin.mockRejectedValueOnce(Object.assign(new Error('last'), { statusCode: 409, code: 'LAST_SUPER_ADMIN' }));
    repository.updateByAdmin.mockClear();
    await expect(updateUserByAdmin('usr_1', 'adm_1', { isActive: false })).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    expect(repository.updateByAdmin).not.toHaveBeenCalled();
    expect(auth.revokeSessions).toHaveBeenCalledTimes(1);

    // An account already inactive, or an edit that is not a deactivation, never asks.
    accessControl.assertNotLastSuperAdmin.mockClear();
    repository.findWithRoles.mockResolvedValue(target({ isActive: false }));
    await updateUserByAdmin('usr_1', 'adm_1', { isActive: false });
    await updateUserByAdmin('usr_1', 'adm_1', { isActive: true });
    expect(accessControl.assertNotLastSuperAdmin).not.toHaveBeenCalled();
  });
});

describe('becoming an admin', () => {
  it('turns the second factor on at creation', async () => {
    await createUser({ mobile: '+919845012210', roles: ['ADMIN'] });
    expect(auth.requireTwoFactorFor).toHaveBeenCalledWith('usr_new');
  });

  it('and when the role is granted later, ending the sessions so the new role is in the token', async () => {
    await assignRole('usr_1', 'ADMIN');
    expect(auth.requireTwoFactorFor).toHaveBeenCalledWith('usr_1');
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'ROLE_ASSIGNED');
  });

  it('leaves a non-admin creation alone', async () => {
    await createUser({ mobile: '+919845012211', roles: ['PUBLISHER'] });
    expect(auth.requireTwoFactorFor).not.toHaveBeenCalled();
  });
});

describe('reading one account back', () => {
  it('carries the console role it holds', async () => {
    const { roleConfig } = await getUserForAdmin('usr_1');
    expect(roleConfig).toEqual({ id: 'rc_1', name: 'Finance' });
  });

  it('is a 404 for an account that does not exist', async () => {
    repository.findProfile.mockResolvedValue(null);
    await expect(getUserForAdmin('nobody')).rejects.toMatchObject({ statusCode: 404 });
  });
});
