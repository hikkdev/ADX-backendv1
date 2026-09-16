import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRepository } from '../notifications.repository';

/**
 * E10-1: `GET /notifications` carries `readCount` beside `unreadCount` —
 * both counted over the user's whole feed, not the page, so the bell can
 * print "3 unread of 41" whichever slice the phone asked for.
 */

const repository = vi.hoisted(
  () =>
    ({
      findManyForUser: vi.fn(),
      countUnread: vi.fn(),
      countRead: vi.fn(),
      findById: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      create: vi.fn(),
      findPreferences: vi.fn(),
      upsertPreference: vi.fn(),
    }) satisfies Record<keyof NotificationRepository, ReturnType<typeof vi.fn>>,
);

vi.mock('../prisma-notifications.repository', () => ({ prismaNotificationRepository: repository }));

import { getNotifications } from '../notifications.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getNotifications', () => {
  it('counts the read beside the unread, over the whole feed', async () => {
    repository.findManyForUser.mockResolvedValue([{ id: 'n-1', read: false }]);
    repository.countUnread.mockResolvedValue(3);
    repository.countRead.mockResolvedValue(38);

    const result = await getNotifications('user-1', { limit: 1 });
    expect(result).toMatchObject({ unreadCount: 3, readCount: 38 });
    expect(result.notifications).toHaveLength(1);
    expect(repository.countRead).toHaveBeenCalledWith('user-1');
    expect(repository.countUnread).toHaveBeenCalledWith('user-1');
  });
});
