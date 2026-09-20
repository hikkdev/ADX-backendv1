import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-22 (the owner, 17 Sep 2026) — the basics after the side.
 *
 * The app asks the person's name, email, date of birth and gender only after
 * the side is chosen, so the party row `chooseParty` opened still carries the
 * number (or the old display name) as its name. Pinned: `PATCH /users/me`
 * with the names mirrors the composed name onto a party row still named
 * after the number or the previous display name, and the email onto a row
 * with none; a row with its own name or email is left alone; a patch that
 * carries neither reads and mirrors nothing; the names and the date of
 * birth travel together with the date converted; and a mirror that fails
 * does not undo the person's own row.
 */

const { repository, publishers, advertisers, identity } = vi.hoisted(() => ({
  repository: { findById: vi.fn(), updateProfile: vi.fn() },
  publishers: { registerPublisher: vi.fn(), updateMyPublisherProfile: vi.fn() },
  advertisers: { registerAdvertiser: vi.fn(), updateProfile: vi.fn() },
  identity: { assertIdentityFree: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../users-identity', () => identity);
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m, registerConsoleStandingResolver: () => undefined }));

import { updateProfile } from '../users.service';

const before = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919876543210',
  name: null,
  firstName: null,
  lastName: null,
  email: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(before());
  identity.assertIdentityFree.mockResolvedValue(undefined);
  publishers.updateMyPublisherProfile.mockResolvedValue({});
  advertisers.updateProfile.mockResolvedValue({});
});

describe('the basics mirrored onto the party rows', () => {
  it('names a publisher row still known by the number, and gives it the email it lacks', async () => {
    repository.updateProfile.mockResolvedValue({
      id: 'usr_1',
      publisherProfile: { id: 'pub_1', name: '+919876543210', email: null },
      advertiserProfile: null,
    });
    await updateProfile('usr_1', { firstName: 'Asha', lastName: 'Rao', email: 'Asha@Example.com', dateOfBirth: '1990-04-12' });

    expect(repository.updateProfile).toHaveBeenCalledWith('usr_1', {
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha@example.com',
      dateOfBirth: expect.any(Date),
      name: 'Asha Rao',
    });
    expect(publishers.updateMyPublisherProfile).toHaveBeenCalledWith('usr_1', { name: 'Asha Rao', email: 'asha@example.com' });
    expect(advertisers.updateProfile).not.toHaveBeenCalled();
  });

  it('renames an advertiser row that carried the previous display name, but not one named on purpose', async () => {
    repository.findById.mockResolvedValue(before({ name: 'Asha', firstName: 'Asha' }));
    repository.updateProfile.mockResolvedValue({
      id: 'usr_1',
      publisherProfile: { id: 'pub_1', name: 'Rao Media Works', email: 'hello@raomedia.in' },
      advertiserProfile: { id: 'adv_1', name: 'Asha', email: null },
    });
    await updateProfile('usr_1', { lastName: 'Rao' });

    expect(advertisers.updateProfile).toHaveBeenCalledWith('adv_1', { name: 'Asha Rao' });
    expect(publishers.updateMyPublisherProfile).not.toHaveBeenCalled();
  });

  it('a patch without names or email neither reads the row first nor mirrors', async () => {
    repository.updateProfile.mockResolvedValue({ id: 'usr_1', publisherProfile: { id: 'pub_1', name: '+919876543210', email: null } });
    await updateProfile('usr_1', { language: 'hi' });

    expect(repository.findById).not.toHaveBeenCalled();
    expect(publishers.updateMyPublisherProfile).not.toHaveBeenCalled();
    expect(advertisers.updateProfile).not.toHaveBeenCalled();
  });

  it('a mirror that fails leaves the person\'s own row saved', async () => {
    repository.updateProfile.mockResolvedValue({ id: 'usr_1', publisherProfile: { id: 'pub_1', name: null, email: null } });
    publishers.updateMyPublisherProfile.mockRejectedValue(new Error('down'));

    await expect(updateProfile('usr_1', { firstName: 'Asha', lastName: 'Rao' })).resolves.toMatchObject({ id: 'usr_1' });
  });
});
