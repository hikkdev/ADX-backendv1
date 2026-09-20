import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-15 (17 Sep 2026) — the desk onboards an advertiser the way the app does.
 *
 * Pinned: the schema's ladder rules apply only when a first name marks an
 * onboarding (a bare account held for a number still needs only a name and
 * the number); a desk onboarding canonicalises the number, opens (or
 * adopts) the sign-in account with the ADVERTISER role and links the
 * profile to it, keeping the person's columns off the profile row; the
 * desk's edit writes those columns to the account behind the profile,
 * composing the display name, and opens the account for a profile nobody
 * has claimed; the detail read carries `person`; the roster takes the two
 * cuts and names who onboarded each row.
 */

const { repository, identifiers } = vi.hoisted(() => ({
  repository: {
    findUserMobile: vi.fn(),
    findAdvertiserByMobile: vi.fn(),
    findAdvertiserById: vi.fn(),
    attachUser: vi.fn(),
    createAdvertiser: vi.fn(),
    updateAdvertiser: vi.fn(),
    ensureAccount: vi.fn(),
    updateAccount: vi.fn(),
    findUserPerson: vi.fn(),
    findUserClosure: vi.fn(),
    findUserLabel: vi.fn(),
    findKycSummary: vi.fn(),
    userLabels: vi.fn(),
    listAdvertisers: vi.fn(),
    ensureWallet: vi.fn(),
    createBrand: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../pricing', () => ({ withCityKey: async (input: unknown) => input }));

import { advertiserRosterQuerySchema, registerAdvertiserSchema, updateProfileSchema } from '../advertisers.schema';
import { getAdvertiserDetail, listAdvertisers, registerAdvertiser, updateProfile } from '../advertisers.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserByMobile.mockResolvedValue(null);
  repository.ensureAccount.mockResolvedValue({ id: 'usr_new', created: true });
  repository.updateAccount.mockResolvedValue(undefined);
  repository.attachUser.mockImplementation(async (id: string, userId: string) => ({ id, userId }));
  repository.createAdvertiser.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'adv_new', type: 'INDIVIDUAL', companyName: null, ...input }));
  repository.updateAdvertiser.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  repository.ensureWallet.mockResolvedValue({});
  repository.createBrand.mockResolvedValue({});
  identifiers.allocateIdentifier.mockImplementation(async (kind: string) => (kind === 'USER' ? 'ADX-1709-2601' : 'ADV-1709-2601'));
});

describe('the desk onboarding rules', () => {
  it("asks for the app's fields only when a first name marks an onboarding", () => {
    // A bare account held for a number: a name and the number, as before.
    expect(registerAdvertiserSchema.safeParse({ name: 'Held', mobile: '9876543210', onBehalf: true }).success).toBe(true);

    const short = registerAdvertiserSchema.safeParse({ name: 'Menon Retail', mobile: '9876543210', onBehalf: true, firstName: 'Meera', type: 'COMMERCIAL' });
    expect(short.success).toBe(false);
    const paths = short.success ? [] : short.error.issues.map((issue) => issue.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['lastName', 'billingAddress', 'city', 'companyName']));

    expect(
      registerAdvertiserSchema.safeParse({
        name: 'Meera Shah',
        mobile: '9876543210',
        onBehalf: true,
        firstName: 'Meera',
        lastName: 'Shah',
        billingAddress: '4, FC Road, Pune',
        city: 'Pune',
        dateOfBirth: '1988-02-14',
        gender: 'FEMALE',
      }).success,
    ).toBe(true);

    // The edit takes the person's columns too, with nothing else required of it.
    expect(updateProfileSchema.safeParse({ firstName: 'Meera' }).success).toBe(true);
    // The roster's cuts, upper-cased like every other enum on the API.
    expect(advertiserRosterQuerySchema.parse({ onboardedVia: 'desk', limit: '10' })).toEqual({ onboardedVia: 'DESK' });
  });
});

describe('registerAdvertiser at the desk', () => {
  it('opens the sign-in account up front for a desk onboarding, on the canonical number', async () => {
    const advertiser = await registerAdvertiser({
      name: 'Meera Shah',
      mobile: '98765 43210',
      email: 'meera@example.in',
      type: 'INDIVIDUAL',
      firstName: 'Meera',
      lastName: 'Shah',
      dateOfBirth: '1988-02-14',
      gender: 'FEMALE',
      onboardedVia: 'DESK',
      onboardedById: 'usr_ops',
      onboardedByRole: 'Ops manager',
      onboardedAt: new Date('2026-09-17T00:00:00Z'),
    });
    expect(repository.findAdvertiserByMobile).toHaveBeenCalledWith('+919876543210');
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('USER');
    expect(repository.ensureAccount).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '+919876543210', displayId: 'ADX-1709-2601', name: 'Meera Shah', email: 'meera@example.in', firstName: 'Meera', lastName: 'Shah', gender: 'FEMALE' }),
    );
    expect(repository.ensureAccount.mock.calls[0]![0].dateOfBirth).toBeInstanceOf(Date);
    expect(repository.createAdvertiser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_new', mobile: '+919876543210', displayId: 'ADV-1709-2601', onboardedVia: 'DESK' }));
    // The person's columns live on the account, never on the profile row.
    expect(repository.createAdvertiser.mock.calls[0]![0]).not.toHaveProperty('firstName');
    expect(repository.createAdvertiser.mock.calls[0]![0]).not.toHaveProperty('dateOfBirth');
    expect(advertiser.userId).toBe('usr_new');
  });

  it('holds a bare account for the number without opening a sign-in', async () => {
    await registerAdvertiser({ name: 'Held', mobile: '9876543210', userId: null, agentId: null });
    expect(repository.ensureAccount).not.toHaveBeenCalled();
    expect(repository.createAdvertiser).toHaveBeenCalledWith(expect.objectContaining({ userId: null, mobile: '+919876543210' }));
  });
});

describe("the desk's edit", () => {
  it("writes the person's columns to the account behind the profile, composing the display name", async () => {
    repository.findAdvertiserById.mockResolvedValue({ id: 'adv_1', userId: 'usr_1', mobile: '+919876543210' });
    repository.findUserPerson.mockResolvedValue({ displayId: 'ADX-1', firstName: 'Meera', lastName: 'S', dateOfBirth: null, gender: null, avatarUrl: null, consentAcceptedAt: null });
    await updateProfile('adv_1', { lastName: 'Shah', email: 'meera@example.in', city: 'Pune' });
    expect(repository.updateAccount).toHaveBeenCalledWith('usr_1', { lastName: 'Shah', name: 'Meera Shah', email: 'meera@example.in' });
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', { email: 'meera@example.in', city: 'Pune' });
  });

  it('opens and links the account when the desk names the person on a profile nobody has claimed', async () => {
    repository.findAdvertiserById.mockResolvedValue({ id: 'adv_1', userId: null, mobile: '9876543210' });
    await updateProfile('adv_1', { firstName: 'Meera', lastName: 'Shah' });
    expect(repository.ensureAccount).toHaveBeenCalledWith(expect.objectContaining({ mobile: '+919876543210', displayId: 'ADX-1709-2601', name: 'Meera Shah', firstName: 'Meera', lastName: 'Shah' }));
    expect(repository.attachUser).toHaveBeenCalledWith('adv_1', 'usr_new');
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', {});
  });

  it('leaves the account alone when only profile fields change', async () => {
    repository.findAdvertiserById.mockResolvedValue({ id: 'adv_1', userId: 'usr_1', mobile: '+919876543210' });
    await updateProfile('adv_1', { city: 'Pune', gstin: '27ABCDE1234F1Z5' });
    expect(repository.findUserPerson).not.toHaveBeenCalled();
    expect(repository.updateAccount).not.toHaveBeenCalled();
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', { city: 'Pune', gstin: '27ABCDE1234F1Z5' });
  });
});

describe('the reads', () => {
  it('carries the person behind the account, and who onboarded them, on the detail read', async () => {
    repository.findAdvertiserById.mockResolvedValue({
      id: 'adv_1',
      userId: 'usr_1',
      kycStatus: 'PENDING',
      onboardedVia: 'DESK',
      onboardedById: 'usr_ops',
      onboardedByRole: 'Ops manager',
      onboardedAt: new Date('2026-09-17T00:00:00Z'),
    });
    repository.findUserClosure.mockResolvedValue({ closedAt: null, closeReason: null });
    repository.findKycSummary.mockResolvedValue(null);
    repository.findUserLabel.mockResolvedValue('Asha Rao');
    repository.findUserPerson.mockResolvedValue({
      displayId: 'ADX-1709-2601',
      firstName: 'Meera',
      lastName: 'Shah',
      dateOfBirth: new Date('1988-02-14T00:00:00Z'),
      gender: 'FEMALE',
      avatarUrl: null,
      consentAcceptedAt: null,
    });
    const detail = await getAdvertiserDetail('adv_1');
    expect(detail.person).toEqual({ displayId: 'ADX-1709-2601', firstName: 'Meera', lastName: 'Shah', dateOfBirth: '1988-02-14', gender: 'FEMALE', avatarUrl: null, consentAcceptedAt: null });
    expect(detail.onboarding).toMatchObject({ via: 'DESK', byName: 'Asha Rao', byRole: 'Ops manager' });
  });

  it('answers null for the person while nobody has claimed the profile', async () => {
    repository.findAdvertiserById.mockResolvedValue({ id: 'adv_2', userId: null, kycStatus: 'PENDING', onboardedVia: null, onboardedById: null, onboardedByRole: null, onboardedAt: null });
    repository.findKycSummary.mockResolvedValue(null);
    const detail = await getAdvertiserDetail('adv_2');
    expect(detail.person).toBeNull();
    expect(repository.findUserPerson).not.toHaveBeenCalled();
  });

  it('cuts the roster by door and by who opened it, and names them', async () => {
    repository.listAdvertisers.mockResolvedValue({
      rows: [
        { id: 'adv_1', onboardedVia: 'DESK', onboardedById: 'usr_ops', onboardedByRole: 'Ops manager', onboardedAt: new Date('2026-09-17T00:00:00Z') },
        { id: 'adv_2', onboardedVia: 'SELF', onboardedById: null, onboardedByRole: null, onboardedAt: new Date('2026-09-16T00:00:00Z') },
      ],
      nextCursor: null,
    });
    repository.userLabels.mockResolvedValue(new Map([['usr_ops', 'Asha Rao']]));
    const page = await listAdvertisers({ onboardedVia: 'DESK', onboardedById: 'usr_ops' });
    expect(repository.listAdvertisers).toHaveBeenCalledWith({ onboardedVia: 'DESK', onboardedById: 'usr_ops' });
    expect(repository.userLabels).toHaveBeenCalledWith(['usr_ops']);
    expect(page.rows[0]).toMatchObject({ onboarding: { via: 'DESK', byName: 'Asha Rao', byRole: 'Ops manager' } });
    expect(page.rows[1]).toMatchObject({ onboarding: { via: 'SELF', byName: null } });
  });
});
