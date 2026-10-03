import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase D (the owner, 1 Oct 2026) — the publisher's legal form on the reads
 * and in the Edit-details drawer.
 *
 * Pinned: the detail, the roster and the publisher's own `/publishers/me`
 * answer `entityType` (the stored value, else what the legacy `type`
 * settles, else null — "ask at the KYC start") and `entityTypeStored`;
 * `PATCH /publishers/:id { entityType }` stores any of the eight (null
 * clears) on an unverified publisher and audits it; on a verified one only
 * the upgrade — an individual's business — is taken, as a fresh Digio
 * request; any other change is 409 `KYC_LOCKED` with nothing written.
 */

const { repository, audit, digio } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    update: vi.fn(),
    updateAccount: vi.fn(),
    findRosterPage: vi.fn(),
    findAllForAdmin: vi.fn(),
    userLabels: vi.fn(async () => new Map()),
    findByUserIdWithKyc: vi.fn(),
    // `settleOnboardingIfReady` reads the row after a desk edit; nothing to settle here.
    findByIdWithUser: vi.fn(async () => null),
    findPlatformAgreementAcceptedAt: vi.fn(async () => null),
  },
  audit: { logActivity: vi.fn(), auditDiff: (before: Record<string, unknown>, after: Record<string, unknown>) => ({ before, after }) },
  digio: { initiateDigioKyc: vi.fn(), getDigioKycStatus: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../pricing', () => ({ withCityKey: async (data: Record<string, unknown>) => data, cityKeyFor: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../kyc', () => ({ kycUserLabels: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn() }));
vi.mock('../kyc/digio.service', () => digio);
vi.mock('../kyc/kyc-desk.service', () => ({}));
vi.mock('../../agreements', () => ({ publisherLicenceFor: vi.fn(async () => null) }));
vi.mock('../../qr', () => ({}));
vi.mock('../../agents', () => ({}));
vi.mock('../../access-grants', () => ({}));
vi.mock('../../payouts', () => ({}));

import { updatePublisherSchema } from '../publishers.schema';
import { getAllPublishers, getPublisherRoster, updatePublisherAtDesk, withEntityType } from '../publishers.service';
import { getMyProfile } from '../onboarding/publisher-onboarding.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: null,
  name: 'Sharma Hoardings',
  mobile: '+919876543210',
  email: 'owner@sharma.in',
  address: '12 Mount Road',
  type: 'BUSINESS',
  entityType: null,
  kycStatus: 'PENDING',
  onboardingStatus: 'ONBOARDING_COMPLETE',
  kyc: null,
  user: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(publisher());
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...publisher(), id, ...patch }));
});

describe('the reads', () => {
  it('answer the effective legal form and whether it was chosen', () => {
    expect(withEntityType(publisher())).toMatchObject({ entityType: null, entityTypeStored: false });
    expect(withEntityType(publisher({ type: 'INDIVIDUAL' }))).toMatchObject({ entityType: 'INDIVIDUAL', entityTypeStored: false });
    expect(withEntityType(publisher({ type: 'NGO' }))).toMatchObject({ entityType: 'NON_PROFIT', entityTypeStored: false });
    expect(withEntityType(publisher({ type: 'POLITICAL' }))).toMatchObject({ entityType: 'POLITICAL', entityTypeStored: false });
    expect(withEntityType(publisher({ entityType: 'LLP_PARTNERSHIP' }))).toMatchObject({ entityType: 'LLP_PARTNERSHIP', entityTypeStored: true });
  });

  it('the roster — the list contract and the bare array — carries both fields on every row', async () => {
    const rows = [publisher({ id: 'pub_1' }), publisher({ id: 'pub_2', type: 'INDIVIDUAL' }), publisher({ id: 'pub_3', entityType: 'COMPANY' })];
    repository.findRosterPage.mockResolvedValue({ items: rows, total: 3, counts: {} });
    const page = (await getPublisherRoster({ page: 1, pageSize: 20 } as never)) as unknown as { items: { id: string; entityType: string | null; entityTypeStored: boolean }[] };
    expect(page.items.map((row) => [row.id, row.entityType, row.entityTypeStored])).toEqual([
      ['pub_1', null, false],
      ['pub_2', 'INDIVIDUAL', false],
      ['pub_3', 'COMPANY', true],
    ]);
    repository.findAllForAdmin.mockResolvedValue(rows);
    const bare = (await getAllPublishers()) as unknown as { entityType: string | null; entityTypeStored: boolean }[];
    expect(bare.map((row) => [row.entityType, row.entityTypeStored])).toEqual([[null, false], ['INDIVIDUAL', false], ['COMPANY', true]]);
  });

  it('the publisher’s own /publishers/me carries them too — null tells the app to ask before the Digio start', async () => {
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ userId: 'usr_1', user: { dateOfBirth: null, gender: null, avatarUrl: null } }));
    expect(await getMyProfile('usr_1')).toMatchObject({ entityType: null, entityTypeStored: false });
    repository.findByUserIdWithKyc.mockResolvedValue(publisher({ userId: 'usr_1', entityType: 'SOLE_PROPRIETOR', user: { dateOfBirth: null, gender: null, avatarUrl: null } }));
    expect(await getMyProfile('usr_1')).toMatchObject({ entityType: 'SOLE_PROPRIETOR', entityTypeStored: true });
  });
});

describe('PATCH /publishers/:publisherId { entityType }', () => {
  it('the body takes any of the eight in any casing, null to clear, and refuses anything else', () => {
    expect(updatePublisherSchema.parse({ entityType: 'government_education' })).toEqual({ entityType: 'GOVERNMENT_EDUCATION' });
    expect(updatePublisherSchema.parse({ entityType: null })).toEqual({ entityType: null });
    expect(updatePublisherSchema.safeParse({ entityType: 'TRUST' }).success).toBe(false);
  });

  it('stores the form on an unverified publisher and audits who chose it', async () => {
    await updatePublisherAtDesk('pub_1', 'usr_admin', { entityType: 'COMPANY' });
    expect(repository.update).toHaveBeenCalledWith('pub_1', { entityType: 'COMPANY' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'KYC_ENTITY_TYPE_SET', expect.objectContaining({
      targetType: 'Publisher',
      targetId: 'pub_1',
      diff: { before: { entityType: null }, after: { entityType: 'COMPANY' } },
      metadata: { party: 'PUBLISHER', at: 'EDIT' },
    }));
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
  });

  it('on a verified KYC: a change other than the upgrade is 409 KYC_LOCKED, nothing written — not even the rest of the patch', async () => {
    repository.findById.mockResolvedValue(publisher({ entityType: 'COMPANY', kycStatus: 'VERIFIED' }));
    await expect(updatePublisherAtDesk('pub_1', 'usr_admin', { entityType: 'LLP_PARTNERSHIP', city: 'Pune' })).rejects.toMatchObject({ statusCode: 409, code: 'KYC_LOCKED' });
    await expect(updatePublisherAtDesk('pub_1', 'usr_admin', { entityType: 'INDIVIDUAL' })).rejects.toMatchObject({ code: 'KYC_LOCKED' });
    // The record alone says verified, too.
    repository.findById.mockResolvedValue(publisher({ entityType: 'COMPANY', kyc: { status: 'VERIFIED' } }));
    await expect(updatePublisherAtDesk('pub_1', 'usr_admin', { entityType: null })).rejects.toMatchObject({ code: 'KYC_LOCKED' });
    expect(repository.update).not.toHaveBeenCalled();
    expect(digio.initiateDigioKyc).not.toHaveBeenCalled();
  });

  it('on a verified individual: the upgrade goes out as a fresh Digio request with the new form', async () => {
    const verified = publisher({ type: 'INDIVIDUAL', kycStatus: 'VERIFIED' });
    repository.findById.mockResolvedValue(verified);
    await updatePublisherAtDesk('pub_1', 'usr_admin', { entityType: 'SOLE_PROPRIETOR' });
    expect(digio.initiateDigioKyc).toHaveBeenCalledWith(verified, { byUserId: 'usr_admin', entityType: 'SOLE_PROPRIETOR', req: undefined });
    // The start writes the entity type with the fresh request; the edit itself does not.
    expect(repository.update).not.toHaveBeenCalledWith('pub_1', { entityType: 'SOLE_PROPRIETOR' });
  });
});
