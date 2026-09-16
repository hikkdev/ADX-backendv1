import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Erasing a person — Lot A (Q60).
 *
 * Four gates, none of them skippable: somebody asks, the account is closed, a
 * DPO approves, an admin executes. The tests below are mostly about what the
 * gates refuse, because that is where this feature can do real damage.
 */

const { repository, audit, appConfig } = vi.hoisted(() => ({
  repository: {
    findParties: vi.fn(),
    createErasure: vi.fn(),
    findErasure: vi.fn(),
    findOpenErasureForUser: vi.fn(),
    updateErasure: vi.fn(),
    listErasures: vi.fn(),
    erase: vi.fn(),
    isTombstoned: vi.fn(),
  },
  audit: { logActivity: vi.fn() },
  appConfig: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-account-lifecycle.repository', () => ({
  prismaAccountLifecycleRepository: repository,
}));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../app-config', () => appConfig);

import {
  approveErasure,
  executeErasure,
  refuseErasure,
  openErasureFor,
  requestErasure,
  wasMobileErased,
} from '../erasure/erasure.service';
import { erasedMobile, hashMobile, retainUntilFor } from '../erasure/retention';

const USER = 'usr_1';
const ADMIN = 'usr_admin';
const MOBILE = '+919876543210';

const parties = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  name: 'Asha Rao',
  mobile: MOBILE,
  email: 'asha@example.com',
  isActive: false,
  closedAt: new Date('2026-09-01T00:00:00Z'),
  closeReason: 'Owner asked to leave',
  publisherId: null,
  advertiserId: null,
  agentProfileId: null,
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  id: 'ers_1',
  userId: USER,
  requestedVia: 'APP',
  requestedAt: new Date('2026-09-02T00:00:00Z'),
  dueAt: new Date('2026-10-02T00:00:00Z'),
  status: 'PENDING',
  reason: 'No longer using ADX',
  approvedById: null,
  approvedAt: null,
  dpoName: null,
  completedAt: null,
  retainUntil: null,
  refusedReason: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findParties.mockResolvedValue(parties());
  repository.findOpenErasureForUser.mockResolvedValue(null);
  repository.createErasure.mockImplementation(async (data: Record<string, unknown>) =>
    request({ ...data }),
  );
  repository.updateErasure.mockImplementation(async (id: string, patch: Record<string, unknown>) =>
    request({ id, ...patch }),
  );
  repository.erase.mockResolvedValue({
    documentsDeleted: 4,
    profilesAnonymised: ['User', 'Publisher'],
    kycRecordsMasked: ['PublisherKyc'],
  });
  repository.isTombstoned.mockResolvedValue(false);
  audit.logActivity.mockResolvedValue(undefined);
  appConfig.getPlatformSettings.mockResolvedValue({ retention: { financialYears: 8, kycYears: 8 } });
});

describe('asking', () => {
  it('opens a request due in thirty days', async () => {
    const result = await requestErasure(USER, { requestedVia: 'APP', reason: 'Done with ADX' });
    expect(result.created).toBe(true);
    const written = repository.createErasure.mock.calls[0]![0] as { dueAt: Date };
    expect(written.dueAt.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });

  it('returns the open request rather than starting a second clock', async () => {
    repository.findOpenErasureForUser.mockResolvedValue(request({ status: 'APPROVED' }));
    const result = await requestErasure(USER, { requestedVia: 'OPS' });
    expect(result.created).toBe(false);
    expect(repository.createErasure).not.toHaveBeenCalled();
  });

  /* E6: GET /users/:id/erasure — the open clock, or null. */
  it('reads the open request back for the account page, null when there is none', async () => {
    await expect(openErasureFor(USER)).resolves.toBeNull();
    repository.findOpenErasureForUser.mockResolvedValue(request({ status: 'PENDING' }));
    await expect(openErasureFor(USER)).resolves.toMatchObject({ status: 'PENDING', userId: USER });
  });

  it('404s for an account that is not there', async () => {
    repository.findParties.mockResolvedValue(null);
    await expect(requestErasure(USER, { requestedVia: 'OPS' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('approving', () => {
  it('refuses while the account is still open', async () => {
    repository.findErasure.mockResolvedValue(request());
    repository.findParties.mockResolvedValue(parties({ closedAt: null }));

    await expect(approveErasure('ers_1', { dpoName: 'R. Menon' }, ADMIN)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ERASURE_NOT_ALLOWED',
    });
    expect(repository.updateErasure).not.toHaveBeenCalled();
  });

  it('records who signed it', async () => {
    repository.findErasure.mockResolvedValue(request());
    const approved = await approveErasure('ers_1', { dpoName: 'R. Menon' }, ADMIN);

    expect(repository.updateErasure).toHaveBeenCalledWith(
      'ers_1',
      expect.objectContaining({ status: 'APPROVED', approvedById: ADMIN, dpoName: 'R. Menon' }),
    );
    expect(approved.dpoName).toBe('R. Menon');
    expect(audit.logActivity).toHaveBeenCalledWith(ADMIN, 'ERASURE_APPROVED', expect.anything());
  });

  it('refuses to approve anything but a pending request', async () => {
    repository.findErasure.mockResolvedValue(request({ status: 'DONE' }));
    await expect(approveErasure('ers_1', { dpoName: 'R. Menon' }, ADMIN)).rejects.toMatchObject({
      code: 'ERASURE_NOT_ALLOWED',
    });
  });
});

describe('refusing', () => {
  it('records the reason', async () => {
    repository.findErasure.mockResolvedValue(request());
    await refuseErasure('ers_1', { reason: 'An open dispute needs the records' }, ADMIN);
    expect(repository.updateErasure).toHaveBeenCalledWith('ers_1', {
      status: 'REFUSED',
      refusedReason: 'An open dispute needs the records',
    });
  });

  it('will not refuse something already carried out', async () => {
    repository.findErasure.mockResolvedValue(request({ status: 'DONE' }));
    await expect(refuseErasure('ers_1', { reason: 'Changed our mind' }, ADMIN)).rejects.toMatchObject(
      { code: 'ERASURE_NOT_ALLOWED' },
    );
  });
});

describe('executing', () => {
  it('refuses anything a DPO has not approved', async () => {
    repository.findErasure.mockResolvedValue(request({ status: 'PENDING' }));
    await expect(executeErasure('ers_1', ADMIN)).rejects.toMatchObject({
      code: 'ERASURE_NOT_ALLOWED',
    });
    expect(repository.erase).not.toHaveBeenCalled();
  });

  it('replaces the number with a value derived from its own hash', async () => {
    repository.findErasure.mockResolvedValue(
      request({ status: 'APPROVED', approvedById: ADMIN, dpoName: 'R. Menon' }),
    );
    repository.findParties.mockResolvedValue(
      parties({ publisherId: 'pub_1', advertiserId: 'adv_1', agentProfileId: 'agt_1' }),
    );

    await executeErasure('ers_1', ADMIN);

    expect(repository.erase).toHaveBeenCalledWith({
      userId: USER,
      userMobile: erasedMobile(MOBILE),
      mobileHash: hashMobile(MOBILE),
      publisher: { id: 'pub_1', mobile: erasedMobile(MOBILE) },
      advertiser: { id: 'adv_1', mobile: erasedMobile(MOBILE) },
      agentProfileId: 'agt_1',
      // AdvertiserKyc is keyed by User.id, not by Advertiser.id.
      advertiserKycUserId: USER,
    });
  });

  it('sets retainUntil from the platform settings, in whole financial years', async () => {
    repository.findErasure.mockResolvedValue(request({ status: 'APPROVED' }));
    appConfig.getPlatformSettings.mockResolvedValue({ retention: { financialYears: 5 } });

    const done = await executeErasure('ers_1', ADMIN);
    const patch = repository.updateErasure.mock.calls[0]![1] as {
      completedAt: Date;
      retainUntil: Date;
      status: string;
    };
    expect(patch.status).toBe('DONE');
    expect(patch.retainUntil.toISOString()).toBe(
      retainUntilFor(patch.completedAt, 5).toISOString(),
    );
    expect(done.footprint).toMatchObject({ documentsDeleted: 4 });
  });

  it('falls back to eight years when the settings cannot be read', async () => {
    repository.findErasure.mockResolvedValue(request({ status: 'APPROVED' }));
    appConfig.getPlatformSettings.mockRejectedValue(new Error('redis down'));

    await executeErasure('ers_1', ADMIN);
    const patch = repository.updateErasure.mock.calls[0]![1] as {
      completedAt: Date;
      retainUntil: Date;
    };
    expect(patch.retainUntil.toISOString()).toBe(
      retainUntilFor(patch.completedAt, 8).toISOString(),
    );
  });

  it('audits against the person, not the request', async () => {
    repository.findErasure.mockResolvedValue(request({ status: 'APPROVED', dpoName: 'R. Menon' }));
    await executeErasure('ers_1', ADMIN);
    expect(audit.logActivity).toHaveBeenCalledWith(
      ADMIN,
      'ACCOUNT_ERASED',
      expect.objectContaining({ targetType: 'User', targetId: USER }),
    );
  });
});

describe('the tombstone', () => {
  it('asks for the hash of the number, never the number', async () => {
    await wasMobileErased(MOBILE);
    expect(repository.isTombstoned).toHaveBeenCalledWith(hashMobile(MOBILE));
  });

  it('answers what the row says', async () => {
    repository.isTombstoned.mockResolvedValue(true);
    expect(await wasMobileErased(MOBILE)).toBe(true);
  });
});
