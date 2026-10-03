import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026) — the users side:
 *
 *  - Deactivate cascades onto the person's profiles (BLOCK_NEW through the
 *    lifecycle port) and Reactivate asks for exactly that to be lifted;
 *  - a closed account is never reactivated (409 ACCOUNT_CLOSED, nothing written);
 *  - `GET /users/:id/deletable` answers `{ deletable, blockers }` — the
 *    history kinds, your own account, the last super admin — and DELETE
 *    refuses on the same history with the blockers named.
 */

const { repository, auth, accessControl, audit } = vi.hoisted(() => ({
  repository: {
    findWithRoles: vi.fn(),
    updateByAdmin: vi.fn(),
    replaceRoles: vi.fn(),
    findDeletionTarget: vi.fn(),
    findDeletionHistory: vi.fn(),
    deleteUserCascade: vi.fn(),
  },
  auth: { normalizeMobile: (m: string) => m, revokeSessions: vi.fn(), expireOutstandingOtpsForUser: vi.fn(), requireTwoFactorFor: vi.fn(), sendPasswordResetLink: vi.fn() },
  accessControl: { getRoleConfigForUser: vi.fn(), assignRoleConfig: vi.fn(), assertNotLastSuperAdmin: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));

import { deleteUser, getDeletability, updateUserByAdmin } from '../users.service';
import { registerAccountLifecyclePort } from '../users.ports';
import { ApiError } from '../../../shared/errors';

const port = { onDeactivated: vi.fn(), onReactivated: vi.fn() };
const account = (over: Record<string, unknown> = {}) => ({ id: 'usr_1', mobile: '+919876543210', email: null, isActive: true, closedAt: null, roles: [{ role: 'PUBLISHER' }], ...over });
const CLEAN = { walletEntries: 0, ledgerLegs: 0, orders: 0, listings: 0, agreementAcceptances: 0, kycRecords: 0, invoices: 0, campaigns: 0, packageSales: 0, accessGrantsUsed: 0, printWork: 0, staffWork: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  registerAccountLifecyclePort(port);
  port.onDeactivated.mockResolvedValue([{ partyType: 'PUBLISHER', partyId: 'pub_1' }]);
  port.onReactivated.mockResolvedValue([{ partyType: 'PUBLISHER', partyId: 'pub_1' }]);
  repository.findWithRoles.mockResolvedValue(account());
  repository.updateByAdmin.mockImplementation(async (_id: string, patch: object) => ({ ...account(), ...patch }));
  repository.findDeletionTarget.mockResolvedValue({ ...account(), agentProfile: null, publisherProfile: { id: 'pub_1' }, advertiserProfile: null, printPartner: null, employeeProfile: null });
  repository.findDeletionHistory.mockResolvedValue({ ...CLEAN });
  accessControl.assertNotLastSuperAdmin.mockResolvedValue(undefined);
});

describe('Deactivate and Reactivate', () => {
  it('Deactivate suspends the profiles through the port and ends the sessions', async () => {
    const result = await updateUserByAdmin('usr_1', 'usr_admin', { isActive: false });
    expect(port.onDeactivated).toHaveBeenCalledWith('usr_1', 'usr_admin');
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_1', 'ACCOUNT_DEACTIVATED');
    expect(result.cascaded).toEqual([{ partyType: 'PUBLISHER', partyId: 'pub_1' }]);
  });

  it('Reactivate asks for exactly what Deactivate placed to be lifted', async () => {
    repository.findWithRoles.mockResolvedValue(account({ isActive: false }));
    await updateUserByAdmin('usr_1', 'usr_admin', { isActive: true });
    expect(port.onReactivated).toHaveBeenCalledWith('usr_1', 'usr_admin');
    expect(port.onDeactivated).not.toHaveBeenCalled();
  });

  it('nothing cascades when the switch does not move', async () => {
    await updateUserByAdmin('usr_1', 'usr_admin', { isActive: true });
    expect(port.onReactivated).not.toHaveBeenCalled();
  });

  it('a closed account is never reactivated — 409 ACCOUNT_CLOSED, nothing written', async () => {
    repository.findWithRoles.mockResolvedValue(account({ isActive: false, closedAt: new Date() }));
    await expect(updateUserByAdmin('usr_1', 'usr_admin', { isActive: true })).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_CLOSED' });
    expect(repository.updateByAdmin).not.toHaveBeenCalled();
    expect(port.onReactivated).not.toHaveBeenCalled();
  });
});

describe('GET /users/:id/deletable', () => {
  it('an account with no history is deletable', async () => {
    expect(await getDeletability('usr_1', 'usr_admin')).toEqual({ deletable: true, blockers: [] });
  });

  it('names every history kind found, in the console’s words', async () => {
    repository.findDeletionHistory.mockResolvedValue({ ...CLEAN, invoices: 2, campaigns: 1, accessGrantsUsed: 3, printWork: 4, staffWork: 5 });
    expect(await getDeletability('usr_1', 'usr_admin')).toEqual({
      deletable: false,
      blockers: [
        { kind: 'invoices', label: 'invoices', count: 2 },
        { kind: 'campaigns', label: 'campaigns', count: 1 },
        { kind: 'accessGrantsUsed', label: 'access grants used', count: 3 },
        { kind: 'printWork', label: 'print jobs and quotes', count: 4 },
        { kind: 'staffWork', label: 'pieces of staff work', count: 5 },
      ],
    });
  });

  it('your own account and the last super admin are blockers too', async () => {
    repository.findDeletionTarget.mockResolvedValue({ ...account({ roles: [{ role: 'ADMIN' }] }), agentProfile: null, publisherProfile: null, advertiserProfile: null });
    accessControl.assertNotLastSuperAdmin.mockRejectedValue(new ApiError(409, 'LAST_SUPER_ADMIN', 'no'));
    const { deletable, blockers } = await getDeletability('usr_1', 'usr_1');
    expect(deletable).toBe(false);
    expect(blockers.map((b) => b.kind)).toEqual(['self', 'lastSuperAdmin']);
  });

  it('404 for nobody', async () => {
    repository.findDeletionTarget.mockResolvedValue(null);
    await expect(getDeletability('usr_x', 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('DELETE /users/:id', () => {
  it('refuses 409 USER_HAS_HISTORY naming the new kinds as blockers', async () => {
    repository.findDeletionHistory.mockResolvedValue({ ...CLEAN, packageSales: 1 });
    await expect(deleteUser('usr_1', 'usr_admin')).rejects.toMatchObject({
      statusCode: 409,
      code: 'USER_HAS_HISTORY',
      details: { blockers: [{ kind: 'packageSales', label: 'package purchases', count: 1 }] },
    });
    expect(repository.deleteUserCascade).not.toHaveBeenCalled();
  });

  it('removes an account with no history', async () => {
    await deleteUser('usr_1', 'usr_admin');
    expect(repository.deleteUserCascade).toHaveBeenCalled();
  });
});
