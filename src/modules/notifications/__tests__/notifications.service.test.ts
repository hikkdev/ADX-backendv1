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
      countRead: vi.fn(),
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

import { createNotification, getNotifications, getOwnedNotification, getPreferences, savePreferences } from '../notifications.service';
import { RELATED_TYPES } from '../notifications.types';

beforeEach(() => {
  vi.clearAllMocks();
});

/* E9: `relatedType` says what `relatedId` names and `payload` carries the
   structured facts behind a notice the apps draw as a modal. Both are
   persisted as sent and come back on every row of the feed. */
describe('relatedType and payload', () => {
  it('persists relatedType and payload with the row, and omits them when the caller sends none', async () => {
    repository.create.mockImplementation(async (data: unknown) => ({ id: 'n-1', ...(data as object) }));

    const withFacts = await createNotification({
      userId: 'user-1',
      type: 'KYC',
      title: 'KYC verified',
      message: 'Asha Rao: KYC verified',
      relatedId: 'pub_1',
      relatedType: 'PUBLISHER',
      payload: { publisherId: 'pub_1', publisherName: 'Asha Rao', status: 'VERIFIED', decidedAt: '2026-09-12T10:00:00.000Z' },
    });
    expect(repository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        relatedId: 'pub_1',
        relatedType: 'PUBLISHER',
        payload: { publisherId: 'pub_1', publisherName: 'Asha Rao', status: 'VERIFIED', decidedAt: '2026-09-12T10:00:00.000Z' },
      }),
    );
    expect(withFacts).toMatchObject({ relatedType: 'PUBLISHER', payload: expect.objectContaining({ publisherId: 'pub_1' }) });

    await createNotification({ userId: 'user-1', type: 'SYSTEM', title: 't', message: 'm' });
    const bare = repository.create.mock.calls[1]![0] as Record<string, unknown>;
    expect(bare).not.toHaveProperty('relatedType');
    expect(bare).not.toHaveProperty('payload');
  });

  it('returns both columns on every row of the feed, null where a notice carries none', async () => {
    repository.findManyForUser.mockResolvedValue([
      { id: 'n-1', userId: 'user-1', type: 'ORDER', relatedId: 'ord_1', relatedType: 'ORDER', payload: null, read: false },
      { id: 'n-2', userId: 'user-1', type: 'ANNOUNCEMENT', relatedId: 'ann_1', relatedType: 'ANNOUNCEMENT', payload: { announcementId: 'ann_1', importance: 'CRITICAL', title: 'Outage', body: 'Back at 9' }, read: false },
      { id: 'n-3', userId: 'user-1', type: 'SYSTEM', relatedId: null, relatedType: null, payload: null, read: true },
    ]);
    repository.countUnread.mockResolvedValue(2);

    const { notifications, unreadCount } = await getNotifications('user-1');
    expect(unreadCount).toBe(2);
    expect(notifications.map((row) => [row.relatedType, row.payload])).toEqual([
      ['ORDER', null],
      ['ANNOUNCEMENT', { announcementId: 'ann_1', importance: 'CRITICAL', title: 'Outage', body: 'Back at 9' }],
      [null, null],
    ]);
  });

  it('names the eleven records a push can open', () => {
    expect([...RELATED_TYPES]).toEqual(['ORDER', 'PUBLISHER', 'ADVERTISER', 'CAMPAIGN', 'STATEMENT', 'WITHDRAWAL', 'TICKET', 'DISPUTE', 'ANNOUNCEMENT', 'LISTING', 'WORK', 'LEAD']);
  });
});

describe('preference defaulting', () => {
  /*
   * The whole matrix — nine kinds across four channels — because the screen
   * draws the whole matrix and a missing row means "never touched", not "off".
   * ORDER and DISPUTE joined the list in DR 07; the channel axis is wave 5;
   * ANNOUNCEMENT is Lot E; WORK is Lot AA.
   */
  it('reports every kind on every channel, defaulted where nothing is saved', async () => {
    repository.findPreferences.mockResolvedValue([{ type: 'PAYOUT', channel: 'IN_APP', enabled: false }]);

    const rows = await getPreferences('user-1');
    expect(rows).toHaveLength(36);
    const at = (type: string, channel: string) => rows.find((row) => row.type === type && row.channel === channel);

    // Saved wins.
    expect(at('PAYOUT', 'IN_APP')).toMatchObject({ enabled: false, mandatory: false });
    // In-app is the record, so it is on for everything else.
    expect(at('ORDER', 'IN_APP')).toMatchObject({ enabled: true });
    // Push follows in-app (G6: on for every kind, SYSTEM included); email is money only; SMS is off.
    expect(at('ORDER', 'PUSH')).toMatchObject({ enabled: true });
    expect(at('SYSTEM', 'PUSH')).toMatchObject({ enabled: true, mandatory: false });
    expect(at('PAYOUT', 'EMAIL')).toMatchObject({ enabled: true });
    expect(at('ORDER', 'EMAIL')).toMatchObject({ enabled: false });
    expect(at('ORDER', 'SMS')).toMatchObject({ enabled: false });
    // Security messages are not a preference; neither is a critical service notice.
    expect(at('SYSTEM', 'SMS')).toMatchObject({ enabled: true, mandatory: true });
    expect(at('SYSTEM', 'EMAIL')).toMatchObject({ enabled: true, mandatory: true });
    expect(at('ANNOUNCEMENT', 'SMS')).toMatchObject({ enabled: true, mandatory: true });
    expect(at('ANNOUNCEMENT', 'EMAIL')).toMatchObject({ enabled: true, mandatory: false });
  });

  it('upserts one row per submitted preference, defaulting the channel to in-app', async () => {
    repository.upsertPreference.mockResolvedValue({});

    await savePreferences('user-1', [
      { type: 'KYC', enabled: false },
      { type: 'ORDER', channel: 'PUSH', enabled: false },
    ]);

    expect(repository.upsertPreference).toHaveBeenCalledTimes(2);
    expect(repository.upsertPreference).toHaveBeenCalledWith('user-1', 'KYC', 'IN_APP', false);
    expect(repository.upsertPreference).toHaveBeenCalledWith('user-1', 'ORDER', 'PUSH', false);
  });

  it('will not save a mandatory row off, whatever was sent', async () => {
    repository.upsertPreference.mockResolvedValue({});
    await savePreferences('user-1', [{ type: 'SYSTEM', channel: 'SMS', enabled: false }]);
    expect(repository.upsertPreference).toHaveBeenCalledWith('user-1', 'SYSTEM', 'SMS', true);
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
