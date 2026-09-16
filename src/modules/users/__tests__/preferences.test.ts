import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a person decided about their own account.
 *
 * What is pinned: an unsaved key reads as its default rather than as null, so
 * a new switch ships without a migration; only the known keys are accepted;
 * and a save answers with the whole map, so a screen never has to merge.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findPreferences: vi.fn(), upsertPreference: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));

import { getUserPreferences, PREFERENCE_KEY_LIST, savePreferencesSchema, saveUserPreferences } from '../preferences';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPreferences.mockResolvedValue([]);
  repository.upsertPreference.mockResolvedValue(undefined);
});

describe('reading them', () => {
  it('answers every key, defaulted where nothing is saved', async () => {
    const map = await getUserPreferences('usr_1');
    expect(Object.keys(map).sort()).toEqual([...PREFERENCE_KEY_LIST].sort());
    expect(map['privacy.showName']).toBe(true);
    expect(map['privacy.locationSharing']).toBe('duringJobs');
    expect(map['app.theme']).toBe('system');
    expect(map['app.dataSaver']).toBe(false);
    expect(map['notifications.quietHours']).toBe('22:00-07:00');
  });

  it('prefers what was saved, and ignores a row whose value is not a switch or a choice', async () => {
    repository.findPreferences.mockResolvedValue([
      { key: 'privacy.showPhoto', value: false },
      { key: 'app.theme', value: 'dark' },
      { key: 'app.sounds', value: { nonsense: true } },
      { key: 'gone.away', value: true },
    ]);
    const map = await getUserPreferences('usr_1');
    expect(map['privacy.showPhoto']).toBe(false);
    expect(map['app.theme']).toBe('dark');
    expect(map['app.sounds']).toBe(true);
    expect('gone.away' in map).toBe(false);
  });
});

describe('writing them', () => {
  it('saves each key and answers with the whole map', async () => {
    repository.findPreferences.mockResolvedValue([{ key: 'app.haptics', value: false }]);
    const map = await saveUserPreferences('usr_1', { 'app.haptics': false });
    expect(repository.upsertPreference).toHaveBeenCalledWith('usr_1', 'app.haptics', false);
    expect(map['app.haptics']).toBe(false);
    expect(map['app.theme']).toBe('system');
  });

  it('takes only the keys it knows, and only switches and short choices', () => {
    expect(savePreferencesSchema.safeParse({ 'privacy.showName': false }).success).toBe(true);
    expect(savePreferencesSchema.safeParse({ 'app.mapStyle': 'satellite' }).success).toBe(true);
    expect(savePreferencesSchema.safeParse({ 'app.theme': 'x'.repeat(100) }).success).toBe(false);
    expect(savePreferencesSchema.safeParse({ 'something.else': true }).success).toBe(false);
    expect(savePreferencesSchema.safeParse({}).success).toBe(false);
  });
});
