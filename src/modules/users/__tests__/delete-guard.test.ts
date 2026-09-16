import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A: an account with history is closed, never deleted.
 *
 * `deleteUserCascade` takes the orders, the listings and the milestones with
 * it, and the ledger legs that balance against ADX would be left describing a
 * party that no longer exists. So the delete now asks first, and names what it
 * found — an admin who is told "3 orders, 1 KYC record" knows why the button
 * refused, which "cannot delete" never told them.
 */

const { repository, auth, accessControl } = vi.hoisted(() => ({
  repository: {
    findDeletionTarget: vi.fn(),
    findDeletionHistory: vi.fn(),
    deleteUserCascade: vi.fn(),
  },
  auth: { normalizeMobile: (m: string) => m },
  // Lot K2: "the last Super Admin" is access-control's rule, asked here.
  accessControl: { getRoleConfigForUser: vi.fn(), assertNotLastSuperAdmin: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../publishers', () => ({ registerPublisher: vi.fn() }));
vi.mock('../../advertisers', () => ({ registerAdvertiser: vi.fn() }));

import { deleteUser } from '../users.service';

const clean = {
  walletEntries: 0,
  ledgerLegs: 0,
  orders: 0,
  listings: 0,
  agreementAcceptances: 0,
  kycRecords: 0,
};

const target = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919876543210',
  roles: [{ role: 'PUBLISHER' }],
  agentProfile: null,
  publisherProfile: { id: 'pub_1' },
  advertiserProfile: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findDeletionTarget.mockResolvedValue(target());
  repository.findDeletionHistory.mockResolvedValue({ ...clean });
  repository.deleteUserCascade.mockResolvedValue(undefined);
  accessControl.assertNotLastSuperAdmin.mockResolvedValue(undefined);
});

describe('deleting a user', () => {
  it('goes through for an account with nothing behind it', async () => {
    await expect(deleteUser('usr_1', 'usr_admin')).resolves.toMatchObject({ mobile: '+919876543210' });
    expect(repository.deleteUserCascade).toHaveBeenCalled();
  });

  it('refuses 409 USER_HAS_HISTORY and names what it found', async () => {
    repository.findDeletionHistory.mockResolvedValue({ ...clean, orders: 3, kycRecords: 1 });

    await expect(deleteUser('usr_1', 'usr_admin')).rejects.toMatchObject({
      statusCode: 409,
      code: 'USER_HAS_HISTORY',
      details: {
        userId: 'usr_1',
        has: [
          { kind: 'orders', label: 'orders', count: 3 },
          { kind: 'kycRecords', label: 'KYC records', count: 1 },
        ],
      },
    });
    expect(repository.deleteUserCascade).not.toHaveBeenCalled();
  });

  it.each([
    ['walletEntries', 'wallet entries'],
    ['ledgerLegs', 'ledger entries'],
    ['orders', 'orders'],
    ['listings', 'listings'],
    ['agreementAcceptances', 'accepted agreements'],
    ['kycRecords', 'KYC records'],
  ])('refuses on %s alone', async (kind, label) => {
    repository.findDeletionHistory.mockResolvedValue({ ...clean, [kind]: 1 });
    await expect(deleteUser('usr_1', 'usr_admin')).rejects.toMatchObject({
      code: 'USER_HAS_HISTORY',
      message: expect.stringContaining(label),
    });
  });

  it('points the admin at closure rather than leaving them stuck', async () => {
    repository.findDeletionHistory.mockResolvedValue({ ...clean, walletEntries: 12 });
    await expect(deleteUser('usr_1', 'usr_admin')).rejects.toMatchObject({
      details: { closeWith: 'account closure' },
    });
  });

  it('still refuses the older refusals first, before it looks for history', async () => {
    await expect(deleteUser('usr_1', 'usr_1')).rejects.toMatchObject({ statusCode: 400 });

    repository.findDeletionTarget.mockResolvedValue(null);
    await expect(deleteUser('usr_gone', 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });

    repository.findDeletionTarget.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }] }));
    accessControl.assertNotLastSuperAdmin.mockRejectedValueOnce(Object.assign(new Error('last'), { statusCode: 409, code: 'LAST_SUPER_ADMIN' }));
    await expect(deleteUser('usr_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    expect(repository.findDeletionHistory).not.toHaveBeenCalled();
  });

  it('Lot K2: the last-admin rule is system-role membership, asked of access-control for an admin and never for anybody else', async () => {
    await deleteUser('usr_1', 'usr_admin');
    expect(accessControl.assertNotLastSuperAdmin).not.toHaveBeenCalled();

    repository.findDeletionTarget.mockResolvedValue(target({ roles: [{ role: 'ADMIN' }] }));
    await deleteUser('usr_1', 'usr_admin');
    expect(accessControl.assertNotLastSuperAdmin).toHaveBeenCalledWith('usr_1', 'DELETE');
    expect(repository.deleteUserCascade).toHaveBeenCalledTimes(2);
  });
});
