import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order fraud screening (the owner, 2 Oct 2026) — `fraud.orderScreening`.
 *
 * Pinned: watch mode ships — screening on, automatic holds OFF, the review
 * at 0.5 and the hold at 0.8, the four signal parameters at the owner's
 * numbers; a PUT moves any field alone (deep-patched; the scan's own two
 * settings untouched), within its bounds; the hold threshold may not sit
 * below the review threshold, whichever side the patch moved; an unknown
 * key is refused; and a row stored before the section existed reads as
 * watch mode — never as automatic holds on.
 */

const { cache, config } = vi.hoisted(() => ({
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  config: { getConfigObject: vi.fn(), saveConfigObject: vi.fn() },
}));

vi.mock('../../../shared/cache', () => cache);
vi.mock('../app-config.service', () => config);

import { DEFAULT_PLATFORM_SETTINGS, getPlatformSettings, platformSettingsPatchSchema, updatePlatformSettings } from '../platform-settings';

beforeEach(() => {
  vi.clearAllMocks();
  config.getConfigObject.mockResolvedValue(null);
  config.saveConfigObject.mockImplementation(async (_key: string, value: unknown) => value);
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
});

describe('the order screening settings', () => {
  it('ship in watch mode', () => {
    expect(DEFAULT_PLATFORM_SETTINGS.fraud.orderScreening).toEqual({
      enabled: true,
      reviewThreshold: 0.5,
      holdThreshold: 0.8,
      autoHold: false,
      newAccountDays: 7,
      bigOrderAmount: 100000,
      velocityCount: 5,
      velocityMinutes: 60,
    });
  });

  it('take any field alone, within bounds, and refuse an unknown one', () => {
    const ok = (orderScreening: Record<string, unknown>) => platformSettingsPatchSchema.safeParse({ fraud: { orderScreening } }).success;
    expect(ok({ autoHold: true })).toBe(true);
    expect(ok({ reviewThreshold: 0.4 })).toBe(true);
    expect(ok({ newAccountDays: 14, bigOrderAmount: 250000, velocityCount: 3, velocityMinutes: 30 })).toBe(true);
    expect(ok({ reviewThreshold: 1.2 })).toBe(false);
    expect(ok({ holdThreshold: -0.1 })).toBe(false);
    expect(ok({ newAccountDays: 0 })).toBe(false);
    expect(ok({ velocityCount: 2.5 })).toBe(false);
    expect(ok({ autoHold: 'yes' })).toBe(false);
    expect(ok({ autoCancel: true })).toBe(false);
  });

  it('deep-patch: the hold switch alone keeps the thresholds and the scan’s own settings', async () => {
    config.getConfigObject.mockResolvedValue({ ...DEFAULT_PLATFORM_SETTINGS, fraud: { scanThreshold: 0.7, scanLimitPerType: 200, orderScreening: { ...DEFAULT_PLATFORM_SETTINGS.fraud.orderScreening, reviewThreshold: 0.45 } } });
    const { after } = await updatePlatformSettings({ fraud: { orderScreening: { autoHold: true } } });
    expect(after.fraud).toEqual({ scanThreshold: 0.7, scanLimitPerType: 200, orderScreening: { ...DEFAULT_PLATFORM_SETTINGS.fraud.orderScreening, reviewThreshold: 0.45, autoHold: true } });
  });

  it('refuse a hold threshold below the review threshold, whichever side moved', async () => {
    await expect(updatePlatformSettings({ fraud: { orderScreening: { holdThreshold: 0.4 } } })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(updatePlatformSettings({ fraud: { orderScreening: { reviewThreshold: 0.9 } } })).rejects.toMatchObject({ statusCode: 400 });
    expect(config.saveConfigObject).not.toHaveBeenCalled();
    const { after } = await updatePlatformSettings({ fraud: { orderScreening: { reviewThreshold: 0.8, holdThreshold: 0.8 } } });
    expect(after.fraud.orderScreening).toMatchObject({ reviewThreshold: 0.8, holdThreshold: 0.8 });
  });

  it('read a row stored before the section existed as watch mode', async () => {
    config.getConfigObject.mockResolvedValue({ fraud: { scanThreshold: 0.6, scanLimitPerType: 500 } });
    expect((await getPlatformSettings()).fraud.orderScreening.autoHold).toBe(false);
  });
});
