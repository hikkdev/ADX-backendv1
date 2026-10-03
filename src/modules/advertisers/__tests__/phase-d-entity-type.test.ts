import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase D (the owner, 1 Oct 2026) — the advertiser's legal form on the reads
 * and in the Edit-details drawer.
 *
 * Pinned: every read answers `entityType` (the stored value, else what the
 * legacy `type` settles, else null — "ask at the KYC start") and
 * `entityTypeStored`; `PATCH /advertisers/:id { entityType }` stores any of
 * the eight (null clears) on an unverified advertiser and audits it; on a
 * verified one only the upgrade — an individual's business — is taken, and
 * it goes out through the KYC module's port as a fresh Digio request; any
 * other change is 409 `KYC_LOCKED` with nothing written.
 */

const { repository, audit } = vi.hoisted(() => ({
  repository: {
    findAdvertiserById: vi.fn(),
    updateAdvertiser: vi.fn(),
    updateAccount: vi.fn(),
    findUserPerson: vi.fn(),
    findUserClosure: vi.fn(),
    findUserLabel: vi.fn(),
    findKycSummary: vi.fn(),
    findKycSummaries: vi.fn(async (rows: { id: string }[]) => new Map(rows.map((r) => [r.id, null]))),
    userLabels: vi.fn(async () => new Map()),
    listAdvertisers: vi.fn(),
  },
  audit: { logActivity: vi.fn(), auditDiff: (before: Record<string, unknown>, after: Record<string, unknown>) => ({ before, after }) },
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../pricing', () => ({ withCityKey: async (input: unknown) => input, cityKeyFor: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);

import { updateProfileSchema } from '../advertisers.schema';
import { getAdvertiserDetail, listAdvertisers, registerAdvertiserKycUpgradePort, updateProfile } from '../advertisers.service';

const advertiser = (over: Record<string, unknown> = {}) => ({ id: 'adv_1', userId: null, name: 'Aster Home', companyName: 'Aster Home Pvt Ltd', mobile: '+919812340001', email: null, type: 'COMMERCIAL', entityType: null, kycStatus: 'PENDING', onboardedById: null, ...over });
const actor = { userId: 'usr_admin' };
const upgrade = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserById.mockResolvedValue(advertiser());
  repository.updateAdvertiser.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...advertiser(), id, ...patch }));
  repository.findKycSummary.mockResolvedValue(null);
  registerAdvertiserKycUpgradePort(upgrade);
});

describe('the reads', () => {
  it('the detail answers the effective legal form and whether it was chosen', async () => {
    expect(await getAdvertiserDetail('adv_1')).toMatchObject({ entityType: null, entityTypeStored: false });
    repository.findAdvertiserById.mockResolvedValue(advertiser({ type: 'NGO' }));
    expect(await getAdvertiserDetail('adv_1')).toMatchObject({ entityType: 'NON_PROFIT', entityTypeStored: false });
    repository.findAdvertiserById.mockResolvedValue(advertiser({ type: 'INDIVIDUAL', entityType: 'SOLE_PROPRIETOR' }));
    expect(await getAdvertiserDetail('adv_1')).toMatchObject({ entityType: 'SOLE_PROPRIETOR', entityTypeStored: true });
  });

  it('the roster answers the same two fields on every row', async () => {
    repository.listAdvertisers.mockResolvedValue({
      rows: [advertiser({ id: 'adv_1' }), advertiser({ id: 'adv_2', type: 'INDIVIDUAL' }), advertiser({ id: 'adv_3', entityType: 'COMPANY' })],
      nextCursor: null,
      total: 3,
    });
    const page = (await listAdvertisers({ limit: 20 } as never)) as unknown as { rows: { id: string; entityType: string | null; entityTypeStored: boolean }[] };
    expect(page.rows.map((row) => [row.id, row.entityType, row.entityTypeStored])).toEqual([
      ['adv_1', null, false],
      ['adv_2', 'INDIVIDUAL', false],
      ['adv_3', 'COMPANY', true],
    ]);
  });
});

describe('PATCH /advertisers/:id { entityType }', () => {
  it('the body takes any of the eight in any casing, null to clear, and refuses anything else', () => {
    expect(updateProfileSchema.parse({ entityType: 'llp_partnership' })).toEqual({ entityType: 'LLP_PARTNERSHIP' });
    expect(updateProfileSchema.parse({ entityType: null })).toEqual({ entityType: null });
    expect(updateProfileSchema.safeParse({ entityType: 'TRUST' }).success).toBe(false);
  });

  it('stores the form on an unverified advertiser and audits who chose it', async () => {
    await updateProfile('adv_1', { entityType: 'COMPANY' }, actor);
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', { entityType: 'COMPANY' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'KYC_ENTITY_TYPE_SET', expect.objectContaining({
      targetType: 'Advertiser',
      targetId: 'adv_1',
      diff: { before: { entityType: null }, after: { entityType: 'COMPANY' } },
      metadata: { party: 'ADVERTISER', at: 'EDIT' },
    }));
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('clears a stored form back to what the type says', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ entityType: 'COMPANY' }));
    await updateProfile('adv_1', { entityType: null }, actor);
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', { entityType: null });
  });

  it('on a verified KYC: a change other than the upgrade is 409 KYC_LOCKED, nothing written — not even the rest of the patch', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ entityType: 'COMPANY', kycStatus: 'VERIFIED' }));
    await expect(updateProfile('adv_1', { entityType: 'LLP_PARTNERSHIP', city: 'Pune' }, actor)).rejects.toMatchObject({ statusCode: 409, code: 'KYC_LOCKED' });
    await expect(updateProfile('adv_1', { entityType: 'INDIVIDUAL' }, actor)).rejects.toMatchObject({ code: 'KYC_LOCKED' });
    await expect(updateProfile('adv_1', { entityType: null }, actor)).rejects.toMatchObject({ code: 'KYC_LOCKED' });
    expect(repository.updateAdvertiser).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('on a verified individual: the upgrade goes out through the KYC module’s port, which reopens the KYC with the new form', async () => {
    const verified = advertiser({ type: 'INDIVIDUAL', kycStatus: 'VERIFIED' });
    repository.findAdvertiserById.mockResolvedValue(verified);
    await updateProfile('adv_1', { entityType: 'SOLE_PROPRIETOR' }, actor);
    expect(upgrade).toHaveBeenCalledWith(verified, 'SOLE_PROPRIETOR', actor);
    // The port writes the entity type with the fresh request; the edit itself does not.
    expect(repository.updateAdvertiser).not.toHaveBeenCalledWith('adv_1', { entityType: 'SOLE_PROPRIETOR' });
  });

  it('leaves the form alone when the patch does not name it', async () => {
    await updateProfile('adv_1', { city: 'Pune' }, actor);
    expect(repository.updateAdvertiser).toHaveBeenCalledTimes(1);
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', { city: 'Pune' });
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});
