import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRepository } from '../notifications.repository';

// vi.hoisted, so the stub exists before vi.mock's factory runs during the
// static import below. A top-level await import would work at runtime but the
// project compiles to CommonJS, where top-level await is a type error.
const repository = vi.hoisted(
  () =>
    ({
      findManyForUser: vi.fn(),
      countUnread: vi.fn(),
      findById: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      create: vi.fn(),
      findPreferences: vi.fn(),
      upsertPreference: vi.fn(),
    }) satisfies Record<keyof NotificationRepository, ReturnType<typeof vi.fn>>,
);

vi.mock('../prisma-notifications.repository', () => ({
  prismaNotificationRepository: repository,
}));

import { getOwnedNotification, getPreferences, savePreferences } from '../notifications.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('preference defaulting', () => {
  it('reports every type, defaulting unsaved ones to enabled', async () => {
    repository.findPreferences.mockResolvedValue([{ type: 'PAYOUT', enabled: false }]);

    await expect(getPreferences('user-1')).resolves.toEqual([
      { type: 'BOOKING', enabled: true },
      { type: 'PAYOUT', enabled: false },
      { type: 'KYC', enabled: true },
      { type: 'MESSAGE', enabled: true },
      { type: 'SYSTEM', enabled: true },
    ]);
  });

  it('upserts one row per submitted preference and leaves the rest alone', async () => {
    repository.upsertPreference.mockResolvedValue({});

    await savePreferences('user-1', [
      { type: 'KYC', enabled: false },
      { type: 'SYSTEM', enabled: true },
    ]);

    expect(repository.upsertPreference).toHaveBeenCalledTimes(2);
    expect(repository.upsertPreference).toHaveBeenCalledWith('user-1', 'KYC', false);
    expect(repository.upsertPreference).toHaveBeenCalledWith('user-1', 'SYSTEM', true);
  });
});

describe('ownership', () => {
  it('returns the notification to its owner', async () => {
    repository.findById.mockResolvedValue({ id: 'n-1', userId: 'user-1' });
    await expect(getOwnedNotification('n-1', 'user-1')).resolves.toMatchObject({ id: 'n-1' });
  });

  it('hides another user notification rather than reporting it exists', async () => {
    repository.findById.mockResolvedValue({ id: 'n-1', userId: 'someone-else' });
    await expect(getOwnedNotification('n-1', 'user-1')).resolves.toBeNull();
  });

  it('returns null for an unknown id', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(getOwnedNotification('nope', 'user-1')).resolves.toBeNull();
  });
});
