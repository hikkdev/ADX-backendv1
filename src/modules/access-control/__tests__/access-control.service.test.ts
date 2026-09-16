import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A — console access.
 *
 * What is pinned: a role may only name ids the catalogue has; the system role
 * cannot be deleted, renamed or emptied; a role with members cannot be
 * deleted; membership is admin-only, moves rather than accumulates, keeps at
 * least one super admin, and ends the person's sessions; and the launch rule —
 * an ADMIN with no role config holds everything.
 */
const { repository, auth, audit } = vi.hoisted(() => ({
  repository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    upsertByName: vi.fn(),
    countMembers: vi.fn(),
    listMemberUserIds: vi.fn(),
    findMembership: vi.fn(),
    setMembership: vi.fn(),
    clearMembership: vi.fn(),
    isAdmin: vi.fn(),
    userExists: vi.fn(),
  },
  auth: { revokeSessions: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
}));

vi.mock('../prisma-access-control.repository', () => ({ prismaRoleConfigRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../../shared/audit', () => audit);

import { PERMISSIONS } from '../../../shared/auth';
import {
  assertNotLastSuperAdmin,
  assignRoleConfig,
  consoleStandingFor,
  createRoleConfig,
  deleteRoleConfig,
  ensureSystemRoles,
  findRoleMemberUserIds,
  getRoleConfig,
  listRoleConfigs,
  permissionsFor,
  updateRoleConfig,
} from '../access-control.service';
import { SUPER_ADMIN_ROLE, SYSTEM_ROLES } from '../system-roles';

const role = (over: Record<string, unknown> = {}) => ({
  id: 'rc_1',
  name: 'Finance',
  description: null,
  permissions: ['finance.view'],
  isSystem: false,
  createdAt: new Date('2026-09-01'),
  updatedAt: new Date('2026-09-01'),
  // T-B: every read and write of a role carries the member count the list carries.
  _count: { members: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.revokeSessions.mockResolvedValue(undefined);
  repository.findByName.mockResolvedValue(null);
  repository.findById.mockResolvedValue(role());
  repository.create.mockImplementation(async (data: Record<string, unknown>) => role(data));
  repository.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => role(data));
  repository.countMembers.mockResolvedValue(0);
  repository.listMemberUserIds.mockResolvedValue([]);
  repository.findMembership.mockResolvedValue(null);
  repository.isAdmin.mockResolvedValue(true);
  repository.userExists.mockResolvedValue(true);
  repository.setMembership.mockImplementation(async (userId: string, roleConfigId: string) => ({
    id: 'urc_1',
    userId,
    roleConfigId,
    assignedById: 'adm_1',
    assignedAt: new Date(),
    roleConfig: role({ id: roleConfigId, name: 'Finance' }),
  }));
});

describe('validating a role against the catalogue', () => {
  it('refuses an id the catalogue does not have, naming them all', async () => {
    await expect(createRoleConfig({ name: 'Odd', permissions: ['finance.view', 'finance.delete', 'nope'] })).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNKNOWN_PERMISSION',
      details: { unknown: ['finance.delete', 'nope'] },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('accepts a known set and stores it deduplicated', async () => {
    await createRoleConfig({ name: 'Ops', permissions: ['supply.view', 'supply.view', 'supply.edit'] });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ permissions: ['supply.view', 'supply.edit'] }));
  });

  it('T-B: the create, the get and the patch answer the list row — memberCount beside the role, _count folded away', async () => {
    const created = await createRoleConfig({ name: 'Ops', permissions: ['supply.view'] });
    expect(created).toMatchObject({ name: 'Ops', permissions: ['supply.view'], memberCount: 0, isSystem: false });
    expect(created).not.toHaveProperty('_count');

    repository.findById.mockResolvedValue(role({ _count: { members: 3 } }));
    expect(await getRoleConfig('rc_1')).toMatchObject({ id: 'rc_1', memberCount: 3 });

    repository.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => role({ ...data, _count: { members: 3 } }));
    const { before, after } = await updateRoleConfig('rc_1', { description: 'Money desk' });
    expect(before.memberCount).toBe(3);
    expect(after).toMatchObject({ description: 'Money desk', memberCount: 3 });
    expect(after).not.toHaveProperty('_count');
  });

  it('checks the ids before the name conflict, so a typo is a 400 not a 409', async () => {
    repository.findByName.mockResolvedValue(role());
    await expect(createRoleConfig({ name: 'Finance', permissions: ['bad'] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses an unknown id on update too', async () => {
    await expect(updateRoleConfig('rc_1', { permissions: ['bad'] })).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' });
  });
});

describe('the system role', () => {
  beforeEach(() => repository.findById.mockResolvedValue(role({ isSystem: true, name: SUPER_ADMIN_ROLE })));

  it('cannot be emptied or renamed', async () => {
    await expect(updateRoleConfig('rc_1', { permissions: [] })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateRoleConfig('rc_1', { name: 'Something else' })).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('cannot be deleted, even with nobody in it', async () => {
    await expect(deleteRoleConfig('rc_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('still accepts a permission change that leaves it non-empty', async () => {
    await updateRoleConfig('rc_1', { permissions: ['finance.view'] });
    expect(repository.update).toHaveBeenCalled();
  });
});

describe('deleting an ordinary role', () => {
  it('is refused while anybody holds it', async () => {
    repository.countMembers.mockResolvedValue(2);
    await expect(deleteRoleConfig('rc_1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ROLE_HAS_MEMBERS',
      details: { members: 2 },
    });
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('goes through when nobody does', async () => {
    await deleteRoleConfig('rc_1');
    expect(repository.remove).toHaveBeenCalledWith('rc_1');
  });
});

describe('changing what a role may do', () => {
  it('ends the sessions of everyone holding it, because the permissions are in their tokens', async () => {
    repository.listMemberUserIds.mockResolvedValue(['u1', 'u2']);
    await updateRoleConfig('rc_1', { permissions: ['finance.view'] });
    expect(auth.revokeSessions).toHaveBeenCalledWith('u1', 'ROLE_CONFIG_PERMISSIONS_CHANGED');
    expect(auth.revokeSessions).toHaveBeenCalledWith('u2', 'ROLE_CONFIG_PERMISSIONS_CHANGED');
  });

  it('survives one revocation failing', async () => {
    repository.listMemberUserIds.mockResolvedValue(['u1']);
    auth.revokeSessions.mockRejectedValueOnce(new Error('redis down'));
    await expect(updateRoleConfig('rc_1', { permissions: ['finance.view'] })).resolves.toBeTruthy();
  });
});

describe('the list the console draws', () => {
  it('carries the member count and the system flag', async () => {
    repository.findAll.mockResolvedValue([{ ...role({ isSystem: true }), _count: { members: 3 } }]);
    await expect(listRoleConfigs()).resolves.toEqual([expect.objectContaining({ memberCount: 3, isSystem: true })]);
  });
});

describe('membership', () => {
  it('assigns a role, records who did it, and ends the person’s sessions', async () => {
    const result = await assignRoleConfig('usr_1', 'adm_1', { roleConfigId: 'rc_1' });
    expect(repository.setMembership).toHaveBeenCalledWith('usr_1', 'rc_1', 'adm_1');
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'ROLE_CONFIG_ASSIGNED');
    expect(result).toEqual({ userId: 'usr_1', roleConfig: { id: 'rc_1', name: 'Finance' }, previous: null });
  });

  it('refuses a target that does not hold the ADMIN role', async () => {
    repository.isAdmin.mockResolvedValue(false);
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: 'rc_1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.setMembership).not.toHaveBeenCalled();
  });

  it('is a 404 for an unknown user and for an unknown role', async () => {
    repository.userExists.mockResolvedValueOnce(false);
    await expect(assignRoleConfig('nobody', 'adm_1', { roleConfigId: 'rc_1' })).rejects.toMatchObject({ statusCode: 404 });
    repository.findById.mockResolvedValueOnce(null);
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: 'rc_none' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('removes the role on null, and does nothing when there was none', async () => {
    repository.findMembership.mockResolvedValue({
      id: 'urc_1',
      userId: 'usr_1',
      roleConfigId: 'rc_1',
      assignedById: null,
      assignedAt: new Date(),
      roleConfig: role(),
    });
    repository.countMembers.mockResolvedValue(4);
    const removed = await assignRoleConfig('usr_1', 'adm_1', { roleConfigId: null });
    expect(repository.clearMembership).toHaveBeenCalledWith('usr_1');
    expect(removed.roleConfig).toBeNull();
    expect(removed.previous).toEqual({ id: 'rc_1', name: 'Finance' });

    vi.clearAllMocks();
    auth.revokeSessions.mockResolvedValue(undefined);
    repository.findMembership.mockResolvedValue(null);
    repository.userExists.mockResolvedValue(true);
    repository.isAdmin.mockResolvedValue(true);
    await assignRoleConfig('usr_1', 'adm_1', { roleConfigId: null });
    expect(repository.clearMembership).not.toHaveBeenCalled();
    expect(auth.revokeSessions).not.toHaveBeenCalled();
  });

  it('will not strip the last member of the super-admin role', async () => {
    repository.findMembership.mockResolvedValue({
      id: 'urc_1',
      userId: 'usr_1',
      roleConfigId: 'rc_sys',
      assignedById: null,
      assignedAt: new Date(),
      roleConfig: role({ id: 'rc_sys', name: SUPER_ADMIN_ROLE, isSystem: true }),
    });
    repository.countMembers.mockResolvedValue(1);
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: null })).rejects.toMatchObject({ statusCode: 409 });
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: 'rc_other' })).rejects.toMatchObject({ statusCode: 409 });

    repository.countMembers.mockResolvedValue(2);
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: null })).resolves.toMatchObject({ roleConfig: null });
  });

  it('re-assigning the same role is not a last-member removal', async () => {
    repository.findMembership.mockResolvedValue({
      id: 'urc_1',
      userId: 'usr_1',
      roleConfigId: 'rc_sys',
      assignedById: null,
      assignedAt: new Date(),
      roleConfig: role({ id: 'rc_sys', name: SUPER_ADMIN_ROLE, isSystem: true }),
    });
    repository.findById.mockResolvedValue(role({ id: 'rc_sys', name: SUPER_ADMIN_ROLE, isSystem: true }));
    repository.countMembers.mockResolvedValue(1);
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: 'rc_sys' })).resolves.toBeTruthy();
  });

  /* K-B1: the two super-admin pins. */
  it('names the last-member refusal LAST_SUPER_ADMIN, for the strip and for the move', async () => {
    repository.findMembership.mockResolvedValue({
      id: 'urc_1',
      userId: 'usr_1',
      roleConfigId: 'rc_sys',
      assignedById: null,
      assignedAt: new Date(),
      roleConfig: role({ id: 'rc_sys', name: SUPER_ADMIN_ROLE, isSystem: true }),
    });
    repository.countMembers.mockResolvedValue(1);
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: null })).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    await expect(assignRoleConfig('usr_1', 'adm_1', { roleConfigId: 'rc_other' })).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    expect(repository.clearMembership).not.toHaveBeenCalled();
    expect(repository.setMembership).not.toHaveBeenCalled();
  });

  it('grants the system role only when the actor is a super admin — a member of it, or an admin under the launch rule', async () => {
    const system = role({ id: 'rc_sys', name: SUPER_ADMIN_ROLE, isSystem: true });
    repository.findById.mockResolvedValue(system);
    const membership = (userId: string, roleConfig: ReturnType<typeof role>) => ({
      id: `urc_${userId}`,
      userId,
      roleConfigId: roleConfig.id,
      assignedById: null,
      assignedAt: new Date(),
      roleConfig,
    });

    // An admin holding an ordinary role: refused.
    repository.findMembership.mockImplementation(async (userId: string) => (userId === 'adm_finance' ? membership('adm_finance', role({ id: 'rc_fin', name: 'Finance' })) : null));
    await expect(assignRoleConfig('usr_1', 'adm_finance', { roleConfigId: 'rc_sys' })).rejects.toMatchObject({ statusCode: 403, code: 'SUPER_ADMIN_ONLY' });
    expect(repository.setMembership).not.toHaveBeenCalled();

    // A member of the system role: allowed.
    repository.findMembership.mockImplementation(async (userId: string) => (userId === 'adm_super' ? membership('adm_super', system) : null));
    await expect(assignRoleConfig('usr_1', 'adm_super', { roleConfigId: 'rc_sys' })).resolves.toMatchObject({ roleConfig: { id: 'rc_sys' } });

    // An admin with no role config at all (the launch rule) — how the first super admin is made.
    repository.findMembership.mockResolvedValue(null);
    await expect(assignRoleConfig('usr_1', 'adm_first', { roleConfigId: 'rc_sys' })).resolves.toMatchObject({ roleConfig: { id: 'rc_sys' } });

    // An ordinary role is granted by any admin.
    repository.findById.mockResolvedValue(role({ id: 'rc_fin', name: 'Finance' }));
    repository.findMembership.mockImplementation(async (userId: string) => (userId === 'adm_finance' ? membership('adm_finance', role({ id: 'rc_fin', name: 'Finance' })) : null));
    await expect(assignRoleConfig('usr_1', 'adm_finance', { roleConfigId: 'rc_fin' })).resolves.toBeTruthy();
  });
});

/* Lot K2: the same rule on the three other doors — deactivate, delete, close. */
describe('assertNotLastSuperAdmin', () => {
  const system = role({ id: 'rc_sys', name: SUPER_ADMIN_ROLE, isSystem: true });
  const membership = (userId: string, roleConfig: ReturnType<typeof role>) => ({
    id: `urc_${userId}`,
    userId,
    roleConfigId: roleConfig.id,
    assignedById: null,
    assignedAt: new Date(),
    roleConfig,
  });

  it.each(['DEACTIVATE', 'DELETE', 'CLOSE'] as const)('%s: refuses 409 LAST_SUPER_ADMIN when no other active member holds the system role', async (action) => {
    repository.findMembership.mockResolvedValue(membership('adm_1', system));
    repository.listMemberUserIds.mockResolvedValue(['adm_1']);
    await expect(assertNotLastSuperAdmin('adm_1', action)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN', details: { userId: 'adm_1', action } });
    // Counted on the members who can still sign in — a deactivated or closed second member does not count.
    expect(repository.listMemberUserIds).toHaveBeenCalledWith('rc_sys', { activeOnly: true });
  });

  it('lets a super admin go when another active member remains', async () => {
    repository.findMembership.mockResolvedValue(membership('adm_1', system));
    repository.listMemberUserIds.mockResolvedValue(['adm_1', 'adm_2']);
    await expect(assertNotLastSuperAdmin('adm_1', 'DEACTIVATE')).resolves.toBeUndefined();
  });

  it('never refuses somebody outside the system role — an ordinary role, or no role at all', async () => {
    repository.findMembership.mockResolvedValue(membership('adm_fin', role({ id: 'rc_fin', name: 'Finance' })));
    await expect(assertNotLastSuperAdmin('adm_fin', 'DELETE')).resolves.toBeUndefined();
    repository.findMembership.mockResolvedValue(null);
    await expect(assertNotLastSuperAdmin('usr_1', 'CLOSE')).resolves.toBeUndefined();
    expect(repository.listMemberUserIds).not.toHaveBeenCalled();
  });
});

describe('the launch rule', () => {
  it('gives an ADMIN with no role config every permission', async () => {
    await expect(permissionsFor('adm_1', ['ADMIN'])).resolves.toEqual([...PERMISSIONS]);
  });

  it('gives an ADMIN with a role exactly that role’s list', async () => {
    repository.findMembership.mockResolvedValue({
      id: 'urc_1',
      userId: 'adm_1',
      roleConfigId: 'rc_1',
      assignedById: null,
      assignedAt: new Date(),
      roleConfig: role({ permissions: ['finance.view', 'finance.approve'] }),
    });
    await expect(permissionsFor('adm_1', ['ADMIN'])).resolves.toEqual(['finance.view', 'finance.approve']);
  });

  it('gives everyone else nothing, without a lookup', async () => {
    await expect(permissionsFor('pub_1', ['PUBLISHER'])).resolves.toEqual([]);
    expect(repository.findMembership).not.toHaveBeenCalled();
  });
});

describe('the seeded roles', () => {
  it('upserts all six by name, idempotently, with the super admin holding every permission', async () => {
    await ensureSystemRoles();
    expect(repository.upsertByName).toHaveBeenCalledTimes(SYSTEM_ROLES.length);
    expect(repository.upsertByName).toHaveBeenCalledWith(
      expect.objectContaining({ name: SUPER_ADMIN_ROLE, isSystem: true, permissions: [...PERMISSIONS] }),
    );
    const names = repository.upsertByName.mock.calls.map(([arg]) => (arg as { name: string }).name);
    expect(names).toEqual([SUPER_ADMIN_ROLE, 'Ops manager', 'Finance', 'KYC reviewer', 'Support', 'Read-only']);
  });

  it('seeds only the super admin as a system role, and gives Read-only view on everything', async () => {
    await ensureSystemRoles();
    const calls = repository.upsertByName.mock.calls.map(([arg]) => arg as { name: string; isSystem: boolean; permissions: string[] });
    expect(calls.filter((c) => c.isSystem)).toHaveLength(1);
    const readOnly = calls.find((c) => c.name === 'Read-only')!;
    expect(readOnly.permissions.every((id) => id.endsWith('.view'))).toBe(true);
    expect(readOnly.permissions).toContain('finance.view');
  });

  it('every seeded role names only ids the catalogue has', () => {
    for (const spec of SYSTEM_ROLES) {
      for (const id of spec.permissions()) expect(PERMISSIONS, `${spec.name}: ${id}`).toContain(id);
    }
  });
});

describe('the escalation pool read (Lot G, Q127/142)', () => {
  it('answers only the open accounts holding the role, by name', async () => {
    repository.findByName.mockResolvedValue(role({ id: 'rc_c', name: 'Compliance' }));
    repository.listMemberUserIds.mockResolvedValue(['u1']);
    await expect(findRoleMemberUserIds('Compliance')).resolves.toEqual(['u1']);
    expect(repository.findByName).toHaveBeenCalledWith('Compliance');
    expect(repository.listMemberUserIds).toHaveBeenCalledWith('rc_c', { activeOnly: true });
  });

  it('is an empty list for a role nobody made', async () => {
    repository.findByName.mockResolvedValue(null);
    await expect(findRoleMemberUserIds('Compliance')).resolves.toEqual([]);
    expect(repository.listMemberUserIds).not.toHaveBeenCalled();
  });
});

/* M-B: the console standing GET /users/me and GET /auth/2fa/status carry. */
describe('consoleStandingFor', () => {
  it('a non-admin has no console: null and false, with no membership read', async () => {
    await expect(consoleStandingFor('pub_1', ['PUBLISHER'])).resolves.toEqual({ roleConfig: null, isSuperAdmin: false });
    expect(repository.findMembership).not.toHaveBeenCalled();
  });

  it('an ADMIN with no role config is a super admin under the launch rule', async () => {
    await expect(consoleStandingFor('adm_1', ['ADMIN'])).resolves.toEqual({ roleConfig: null, isSuperAdmin: true });
  });

  it('a member reads the role with isSystem, and is a super admin only when the role is the system one', async () => {
    repository.findMembership.mockResolvedValue({ userId: 'adm_1', roleConfigId: 'rc_1', roleConfig: role({ id: 'rc_1', name: 'Finance', isSystem: false }) });
    await expect(consoleStandingFor('adm_1', ['ADMIN', 'PARTNER'])).resolves.toEqual({ roleConfig: { id: 'rc_1', name: 'Finance', isSystem: false }, isSuperAdmin: false });
    repository.findMembership.mockResolvedValue({ userId: 'adm_1', roleConfigId: 'rc_s', roleConfig: role({ id: 'rc_s', name: SUPER_ADMIN_ROLE, isSystem: true }) });
    await expect(consoleStandingFor('adm_1', ['ADMIN'])).resolves.toEqual({ roleConfig: { id: 'rc_s', name: SUPER_ADMIN_ROLE, isSystem: true }, isSuperAdmin: true });
  });

  it('DEMOTE is a way out the rule names', async () => {
    repository.findMembership.mockResolvedValue({ userId: 'adm_1', roleConfigId: 'rc_s', roleConfig: role({ id: 'rc_s', isSystem: true }) });
    repository.listMemberUserIds.mockResolvedValue(['adm_1']);
    await expect(assertNotLastSuperAdmin('adm_1', 'DEMOTE')).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN', message: expect.stringContaining('demoted'), details: { userId: 'adm_1', action: 'DEMOTE' } });
  });
});
