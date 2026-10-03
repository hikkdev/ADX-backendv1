import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ST-3 / ST-4 (28 Sep 2026) — the `storage` section of the platform settings.
 *
 * What is pinned: removal of unreferenced files ships OFF with thirty grace
 * days (the owner turns it on after reviewing the list); the PUT takes the
 * switch and the grace days alone or together, the days within 7–365 and
 * whole; an unknown key is refused; and a row stored before the section
 * existed reads as the defaults for it — never as removal on.
 */

const { cache, config } = vi.hoisted(() => ({
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  config: { getConfigObject: vi.fn(), saveConfigObject: vi.fn() },
}));

vi.mock('../../../shared/cache', () => cache);
vi.mock('../app-config.service', () => config);

import { DEFAULT_PLATFORM_SETTINGS, getPlatformSettings, platformSettingsPatchSchema, platformSettingsSchema, updatePlatformSettings } from '../platform-settings';

beforeEach(() => {
  vi.clearAllMocks();
  config.getConfigObject.mockResolvedValue(null);
  config.saveConfigObject.mockImplementation(async (_key: string, value: unknown) => value);
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
});

describe('the storage settings', () => {
  it('ship with removal OFF and thirty grace days, and parse', () => {
    expect(DEFAULT_PLATFORM_SETTINGS.storage).toEqual({ removeUnreferenced: false, graceDays: 30 });
    expect(platformSettingsSchema.safeParse(DEFAULT_PLATFORM_SETTINGS).success).toBe(true);
  });

  it('take the switch and the grace days, alone or together, within 7–365, whole', () => {
    expect(platformSettingsPatchSchema.safeParse({ storage: { removeUnreferenced: true } }).success).toBe(true);
    expect(platformSettingsPatchSchema.safeParse({ storage: { graceDays: 60 } }).success).toBe(true);
    expect(platformSettingsPatchSchema.safeParse({ storage: { removeUnreferenced: true, graceDays: 7 } }).success).toBe(true);
    expect(platformSettingsPatchSchema.safeParse({ storage: { graceDays: 6 } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ storage: { graceDays: 366 } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ storage: { graceDays: 30.5 } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ storage: { removeUnreferenced: 'yes' } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ storage: { removeFiles: true } }).success).toBe(false);
  });

  it('read a row written before the section existed as removal off', async () => {
    config.getConfigObject.mockResolvedValue({ kyc: { reviewSlaHours: 24 } });
    expect((await getPlatformSettings()).storage).toEqual({ removeUnreferenced: false, graceDays: 30 });
  });

  it('keep the grace days when only the switch is turned', async () => {
    config.getConfigObject.mockResolvedValue({ ...DEFAULT_PLATFORM_SETTINGS, storage: { removeUnreferenced: false, graceDays: 45 } });
    const { after } = await updatePlatformSettings({ storage: { removeUnreferenced: true } });
    expect(after.storage).toEqual({ removeUnreferenced: true, graceDays: 45 });
  });
});
