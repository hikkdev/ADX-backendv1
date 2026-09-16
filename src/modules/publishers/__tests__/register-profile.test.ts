import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How a publisher comes into being from the app.
 *
 * Three arrivals, told apart by what the number already has: nothing (a row
 * is opened and an identifier minted), a row this user owns (returned), and a
 * row with no user — the one an agent opened at the door before its owner
 * ever signed in, which is claimed rather than refused. The unique mobile on
 * Publisher used to turn that third arrival into a 500.
 */

const { repository, identifiers } = vi.hoisted(() => ({
  repository: {
    findByUserId: vi.fn(),
    findUserMobile: vi.fn(),
    findByMobile: vi.fn(),
    attachUser: vi.fn(),
    setUserProfile: vi.fn(),
    createSelfRegistered: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../qr', () => ({
  deactivateQrsFor: vi.fn(),
  findActiveQrFor: vi.fn(),
  generateQr: vi.fn(),
}));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn() }));

import { registerProfile } from '../onboarding/publisher-onboarding.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByUserId.mockResolvedValue(null);
  repository.findUserMobile.mockResolvedValue({ mobile: '+919876543210', name: null });
  repository.findByMobile.mockResolvedValue(null);
  repository.attachUser.mockImplementation(async (id: string, userId: string) => ({ id, userId }));
  repository.setUserProfile.mockResolvedValue({});
  repository.createSelfRegistered.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'pub_new', ...data }));
  identifiers.allocateIdentifier.mockResolvedValue('PUB-1009-2601');
});

describe('a number with nothing yet', () => {
  it('opens a row with a fresh identifier and the account type, named by its number until told otherwise', async () => {
    const result = await registerProfile('usr_1', { type: 'BUSINESS' });

    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('PUBLISHER');
    expect(repository.createSelfRegistered).toHaveBeenCalledWith({
      displayId: 'PUB-1009-2601',
      userId: 'usr_1',
      name: '+919876543210',
      mobile: '+919876543210',
      email: undefined,
      type: 'BUSINESS',
    });
    // No name was given, so the User row is not touched.
    expect(repository.setUserProfile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: true, publisher: { id: 'pub_new', displayId: 'PUB-1009-2601' } });
  });

  it('prefers the name the account already has, and writes a supplied one to the User row too', async () => {
    repository.findUserMobile.mockResolvedValue({ mobile: '+919876543210', name: 'Asha Rao' });
    await registerProfile('usr_1');
    expect(repository.createSelfRegistered).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Asha Rao' }));

    await registerProfile('usr_1', { name: 'Asha R.', email: 'asha@example.in' });
    expect(repository.setUserProfile).toHaveBeenCalledWith('usr_1', 'Asha R.', 'asha@example.in');
    expect(repository.createSelfRegistered).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Asha R.', email: 'asha@example.in' }),
    );
  });
});

describe('a number that already has a row', () => {
  it('returns the row this user owns without minting again', async () => {
    repository.findByUserId.mockResolvedValue({ id: 'pub_mine', userId: 'usr_1' });
    const result = await registerProfile('usr_1', { type: 'INDIVIDUAL' });
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    expect(result).toEqual({ publisher: { id: 'pub_mine', userId: 'usr_1' }, created: false });
  });

  it('claims a row an agent opened for this number, rather than refusing it', async () => {
    repository.findByMobile.mockResolvedValue({ id: 'pub_held', userId: null, displayId: 'PUB-0509-2603' });
    const result = await registerProfile('usr_1', { type: 'INDIVIDUAL' });

    expect(repository.attachUser).toHaveBeenCalledWith('pub_held', 'usr_1');
    expect(identifiers.allocateIdentifier).not.toHaveBeenCalled();
    expect(repository.createSelfRegistered).not.toHaveBeenCalled();
    expect(result).toEqual({ publisher: { id: 'pub_held', userId: 'usr_1' }, created: false });
  });

  it('refuses a row that belongs to somebody else', async () => {
    repository.findByMobile.mockResolvedValue({ id: 'pub_theirs', userId: 'usr_other' });
    await expect(registerProfile('usr_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.attachUser).not.toHaveBeenCalled();
  });
});
