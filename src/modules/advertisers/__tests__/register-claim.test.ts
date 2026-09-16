import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gate 1 when the number already has an account.
 *
 * An agent opens advertiser accounts at the door for people who have not
 * signed in yet — `userId` null, held for them. When that person then signs
 * in and chooses the advertiser side, this is the arrival the unique mobile
 * used to turn into a 409. It is theirs; it is linked. A row that already
 * belongs to somebody, or an agent trying to open a second account on a
 * number, is still refused.
 */

const { repository, identifiers } = vi.hoisted(() => ({
  repository: {
    findUserMobile: vi.fn(),
    findAdvertiserByMobile: vi.fn(),
    attachUser: vi.fn(),
    createAdvertiser: vi.fn(),
    ensureWallet: vi.fn(),
    createBrand: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => identifiers);

import { registerAdvertiser } from '../advertisers.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findUserMobile.mockResolvedValue('+919876543210');
  repository.findAdvertiserByMobile.mockResolvedValue(null);
  repository.attachUser.mockImplementation(async (id: string, userId: string) => ({ id, userId, type: 'INDIVIDUAL' }));
  repository.createAdvertiser.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'adv_new',
    type: 'INDIVIDUAL',
    companyName: null,
    ...input,
  }));
  repository.ensureWallet.mockResolvedValue({});
  repository.createBrand.mockResolvedValue({});
  identifiers.allocateIdentifier.mockResolvedValue('ADV-1009-2601');
});

describe('registerAdvertiser', () => {
  it('opens a new account with an identifier, a wallet and its one brand', async () => {
    const advertiser = await registerAdvertiser({ userId: 'usr_1', name: '+919876543210', type: 'INDIVIDUAL' });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('ADVERTISER');
    expect(repository.createAdvertiser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_1', mobile: '+919876543210', displayId: 'ADV-1009-2601' }),
    );
    expect(repository.ensureWallet).toHaveBeenCalledWith('adv_new');
    expect(repository.createBrand).toHaveBeenCalledWith({ advertiserId: 'adv_new', name: '+919876543210' });
    expect(advertiser).toMatchObject({ id: 'adv_new', displayId: 'ADV-1009-2601' });
  });

  it('links an account an agent opened for this number to its arriving owner', async () => {
    repository.findAdvertiserByMobile.mockResolvedValue({ id: 'adv_held', userId: null });
    const advertiser = await registerAdvertiser({ userId: 'usr_1', name: '+919876543210' });

    expect(repository.attachUser).toHaveBeenCalledWith('adv_held', 'usr_1');
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    expect(repository.createAdvertiser).not.toHaveBeenCalled();
    expect(repository.ensureWallet).not.toHaveBeenCalled();
    expect(advertiser).toMatchObject({ id: 'adv_held', userId: 'usr_1' });
  });

  it('still refuses a number that belongs to somebody', async () => {
    repository.findAdvertiserByMobile.mockResolvedValue({ id: 'adv_theirs', userId: 'usr_other' });
    await expect(registerAdvertiser({ userId: 'usr_1', name: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.attachUser).not.toHaveBeenCalled();
  });

  it('still refuses an agent opening a second account on a held number', async () => {
    repository.findAdvertiserByMobile.mockResolvedValue({ id: 'adv_held', userId: null });
    await expect(registerAdvertiser({ mobile: '+919876543210', name: 'x', agentId: 'agt_1' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(repository.attachUser).not.toHaveBeenCalled();
  });
});
