import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-13 — the desk onboards a publisher the way the app does.
 *
 * Pinned: the create schema applies the ladder's rules once a first name is
 * given (last name, email, address, city, state, date of birth; a business's
 * GSTIN; a contact person for anyone but an individual) and leaves the agent
 * door's quick-add alone; a desk onboarding opens the account (or adopts the
 * one already on the number), links it, and opens the publisher complete
 * when the basics are in; the desk's edit writes the person's fields to the
 * account, opens one for a publisher who had none, settles the onboarding
 * and leaves an audit row.
 */

const { repository, identifiers, audit, settle } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    ensureAccount: vi.fn(),
    updateAccount: vi.fn(),
    attachUser: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    findByIdWithUser: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn() },
  settle: { settleOnboardingIfReady: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../pricing', () => ({ withCityKey: async (data: Record<string, unknown>) => ({ ...data, cityId: data['city'] ? 'city_1' : null }) }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../onboarding/publisher-onboarding.service', () => settle);
vi.mock('../../kyc', () => ({ kycUserLabels: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn() }));
vi.mock('../kyc/digio.service', () => ({ initiateDigioKyc: vi.fn() }));

import { createPublisherSchema, updatePublisherSchema } from '../publishers.schema';
import { createPublisher, updatePublisherAtDesk, withDetailFacts } from '../publishers.service';

const full = {
  name: 'Sharma Hoardings',
  mobile: '9876543210',
  email: 'owner@sharma.in',
  type: 'BUSINESS',
  firstName: 'Rakesh',
  lastName: 'Sharma',
  dateOfBirth: '1980-05-14',
  gender: 'MALE',
  address: '12 Mount Road',
  latitude: 13.06,
  longitude: 80.27,
  city: 'Chennai',
  state: 'Tamil Nadu',
  gstin: '33ABCDE1234F1Z5',
  contactName: 'R. Kumar',
  contactMobile: '9876500000',
};

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockImplementation(async (party: string) => (party === 'USER' ? 'ADX-1709-2601' : 'PUB-1709-2601'));
  repository.ensureAccount.mockResolvedValue({ id: 'usr_new', created: true });
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'pub_new', ...data }));
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  settle.settleOnboardingIfReady.mockResolvedValue(false);
});

describe('the create schema', () => {
  it('leaves the quick-add alone: a name and a number are enough without a person', () => {
    expect(createPublisherSchema.safeParse({ name: 'Sharma Hoardings', mobile: '9876543210' }).success).toBe(true);
  });

  it('applies the ladder once a first name is given', () => {
    const missing = createPublisherSchema.safeParse({ name: 'Sharma Hoardings', mobile: '9876543210', firstName: 'Rakesh', type: 'BUSINESS' });
    expect(missing.success).toBe(false);
    const paths = missing.success ? [] : missing.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['lastName', 'email', 'dateOfBirth', 'address', 'city', 'state', 'gstin', 'contactName', 'contactMobile']));

    expect(createPublisherSchema.safeParse(full).success).toBe(true);
    // An individual needs no GSTIN and no contact person.
    const { gstin: _g, contactName: _c, contactMobile: _m, ...individual } = full;
    expect(createPublisherSchema.safeParse({ ...individual, type: 'INDIVIDUAL' }).success).toBe(true);
    // An organisation needs the contact, not the GSTIN.
    expect(createPublisherSchema.safeParse({ ...individual, type: 'NGO' }).success).toBe(false);
    expect(createPublisherSchema.safeParse({ ...individual, type: 'NGO', contactName: 'A', contactMobile: '9876500000' }).success).toBe(true);
  });

  it('refuses a minor, a bad GSTIN and a half pin', () => {
    expect(createPublisherSchema.safeParse({ ...full, dateOfBirth: '2015-01-01' }).success).toBe(false);
    expect(createPublisherSchema.safeParse({ ...full, gstin: 'nope' }).success).toBe(false);
    const half = createPublisherSchema.safeParse({ ...full, longitude: undefined });
    expect(half.success).toBe(false);
    expect(updatePublisherSchema.safeParse({ latitude: 1 }).success).toBe(false);
    expect(updatePublisherSchema.safeParse({ latitude: null, longitude: null, firstName: 'R' }).success).toBe(true);
  });
});

describe('a desk onboarding', () => {
  it('opens the account, links it, and opens the publisher complete when the basics are in', async () => {
    const { firstName, lastName, dateOfBirth, gender, ...rest } = full;
    const created = await createPublisher({ ...rest, agentId: null, type: 'BUSINESS', firstName, lastName, dateOfBirth, gender: gender as never } as never);
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('USER');
    expect(repository.ensureAccount).toHaveBeenCalledWith({
      mobile: '+919876543210',
      displayId: 'ADX-1709-2601',
      name: 'Rakesh Sharma',
      email: 'owner@sharma.in',
      firstName: 'Rakesh',
      lastName: 'Sharma',
      dateOfBirth: expect.any(Date),
      gender: 'MALE',
    });
    const row = repository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toEqual(
      expect.objectContaining({
        mobile: '+919876543210',
        userId: 'usr_new',
        displayId: 'PUB-1709-2601',
        address: '12 Mount Road',
        latitude: 13.06,
        longitude: 80.27,
        gstin: '33ABCDE1234F1Z5',
        contactName: 'R. Kumar',
        onboardingStatus: 'ONBOARDING_COMPLETE',
        cityId: 'city_1',
      }),
    );
    expect(row['activatedAt']).toBeInstanceOf(Date);
    expect(row).not.toHaveProperty('firstName');
    expect(created.id).toBe('pub_new');
  });

  it('without a person, opens no account and stays pending — the agent door as it was', async () => {
    await createPublisher({ name: 'Sharma Hoardings', mobile: '98765 43210', agentId: 'agt_1' } as never);
    expect(repository.ensureAccount).not.toHaveBeenCalled();
    const row = repository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['mobile']).toBe('+919876543210');
    expect(row).not.toHaveProperty('userId');
    expect(row).not.toHaveProperty('onboardingStatus');
  });

  it('with a person but a basic missing, links the account and stays pending', async () => {
    await createPublisher({ name: 'Sharma Hoardings', mobile: '9876543210', agentId: null, firstName: 'Rakesh', lastName: 'Sharma' } as never);
    expect(repository.ensureAccount).toHaveBeenCalled();
    const row = repository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(row['userId']).toBe('usr_new');
    expect(row).not.toHaveProperty('onboardingStatus');
  });
});

describe("the desk's edit", () => {
  it('writes the person to the account, the rest to the row, settles and audits', async () => {
    repository.findById.mockResolvedValue({ id: 'pub_1', mobile: '+919876543210', userId: 'usr_1', user: { closedAt: null, closeReason: null, firstName: 'Rakesh', lastName: 'Sharma' } });
    await updatePublisherAtDesk('pub_1', 'usr_admin', { lastName: 'Sharma-Iyer', dateOfBirth: '1980-05-14', address: '14 Mount Road', city: 'Chennai' } as never);
    expect(repository.updateAccount).toHaveBeenCalledWith('usr_1', { lastName: 'Sharma-Iyer', dateOfBirth: expect.any(Date), name: 'Rakesh Sharma-Iyer' });
    expect(repository.update).toHaveBeenCalledWith('pub_1', { address: '14 Mount Road', city: 'Chennai', cityId: 'city_1' });
    expect(settle.settleOnboardingIfReady).toHaveBeenCalledWith('pub_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_UPDATED_BY_ADMIN', undefined, { publisherId: 'pub_1', fields: ['lastName', 'dateOfBirth', 'address', 'city'] });
  });

  it('opens an account for a publisher who had none, and links it', async () => {
    repository.findById.mockResolvedValue({ id: 'pub_2', mobile: '9876543210', userId: null, user: null });
    await updatePublisherAtDesk('pub_2', 'usr_admin', { firstName: 'Meena', lastName: 'Rao', email: 'meena@example.in' } as never);
    expect(repository.ensureAccount).toHaveBeenCalledWith(expect.objectContaining({ mobile: '+919876543210', displayId: 'ADX-1709-2601', name: 'Meena Rao', email: 'meena@example.in', firstName: 'Meena', lastName: 'Rao' }));
    expect(repository.attachUser).toHaveBeenCalledWith('pub_2', 'usr_new');
    expect(repository.update).toHaveBeenCalledWith('pub_2', { email: 'meena@example.in', cityId: null });
  });

  it('a publisher the desk does not know is 404', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(updatePublisherAtDesk('pub_x', 'usr_admin', { city: 'Pune' } as never)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the detail read', () => {
  it('carries the person when the read joined them, and nothing extra when it did not', () => {
    const joined = withDetailFacts({ listings: [], user: { closedAt: null, closeReason: null, displayId: 'ADX-1709-2601', firstName: 'Rakesh', lastName: 'Sharma', dateOfBirth: new Date('1980-05-14T00:00:00.000Z'), gender: 'MALE', avatarUrl: null, consentAcceptedAt: null } });
    expect((joined as { person: unknown }).person).toEqual({ displayId: 'ADX-1709-2601', firstName: 'Rakesh', lastName: 'Sharma', dateOfBirth: '1980-05-14', gender: 'MALE', avatarUrl: null, consentAcceptedAt: null });
    expect(joined.user).toEqual({ closedAt: null, closeReason: null });
    const bare = withDetailFacts({ listings: [], user: { closedAt: null, closeReason: null } });
    expect(bare).not.toHaveProperty('person');
  });
});
