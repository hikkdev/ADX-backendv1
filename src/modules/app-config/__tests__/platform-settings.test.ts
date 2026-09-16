import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The platform settings row — Lot A, Q31.
 *
 * What is pinned here: the defaults are the shipped policy and they parse;
 * a PUT is a deep patch, never a replacement, so naming one number cannot
 * quietly reset the fifteen beside it; a row half-written by hand is served
 * as the defaults rather than as a partial document; and the write
 * invalidates the cache the readers share, because a floor that took a
 * minute to take effect is a floor that was not enforced for a minute.
 */

const { cache, config } = vi.hoisted(() => ({
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  config: { getConfigObject: vi.fn(), saveConfigObject: vi.fn() },
}));

vi.mock('../../../shared/cache', () => cache);
vi.mock('../app-config.service', () => config);

import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTINGS_CACHE_KEY,
  PLATFORM_SETTINGS_KEY,
  PLATFORM_SETTINGS_TTL_SECONDS,
  deepMerge,
  flattenSettings,
  getPlatformSettings,
  getSubscriptionPolicy,
  platformSettingsPatchSchema,
  platformSettingsSchema,
  updatePlatformSettings,
} from '../platform-settings';

beforeEach(() => {
  vi.clearAllMocks();
  config.getConfigObject.mockResolvedValue(null);
  config.saveConfigObject.mockImplementation(async (_key: string, value: unknown) => value);
  // The real read-through, minus Redis: the loader is called and its answer returned.
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
});

describe('the defaults', () => {
  it('are the shipped policy, and they parse', () => {
    expect(platformSettingsSchema.safeParse(DEFAULT_PLATFORM_SETTINGS).success).toBe(true);
    expect(DEFAULT_PLATFORM_SETTINGS.kyc.reviewSlaHours).toBe(48);
    expect(DEFAULT_PLATFORM_SETTINGS.listings.autoPublishOnVerification).toBe(true);
    expect(DEFAULT_PLATFORM_SETTINGS.marketplace).toEqual({ minBookingDays: 1, maxMarketsPerCampaign: 3 });
    expect(DEFAULT_PLATFORM_SETTINGS.publisher.spotInsightsVisible).toBe(false);
    expect(DEFAULT_PLATFORM_SETTINGS.retention).toEqual({ financialYears: 8, kycYears: 8 });
    expect(DEFAULT_PLATFORM_SETTINGS.support.sla.URGENT).toEqual({ firstResponseHours: 1, resolutionHours: 4 });
    expect(DEFAULT_PLATFORM_SETTINGS.support.sla.LOW).toEqual({ firstResponseHours: 24, resolutionHours: 168 });
    expect(DEFAULT_PLATFORM_SETTINGS.auth.adminPasswordLoginEnabled).toBe(true);
    // Lot K2: the authenticator app is offered, not required, and SMS stays beside it.
    expect(DEFAULT_PLATFORM_SETTINGS.auth.adminTwoFactor).toEqual({ authenticatorRequired: false, smsAllowedWhenEnrolled: true });
    expect(DEFAULT_PLATFORM_SETTINGS.installation.commissionMode).toBe('FLAT');
    // Lot B (Q85): one platform-wide primary rail, manual last in the fallback.
    expect(DEFAULT_PLATFORM_SETTINGS.finance).toEqual({
      primaryRail: 'MANUAL_NEFT',
      railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'],
      payoutEtaHours: 48,
      clearingDays: 7,
      // Lot C (Q88): ops authorising on behalf above this needs a second admin.
      opsAuthoriseThreshold: 50_000,
      // Lot G (Q124): the weekly draft, Monday 10:00 IST.
      payoutBatchCadence: { enabled: true, weekday: 1, hourIst: 10 },
    });
    // Lot G (Q117): quiet hours and the weekly cap for non-transactional copy.
    expect(DEFAULT_PLATFORM_SETTINGS.comms).toEqual({ quietHours: { from: '21:00', to: '08:00', tz: 'Asia/Kolkata' }, weeklyCapPerUser: 5 });
  });

  it('are served when nothing is stored, through the cache and its minute', async () => {
    expect(await getPlatformSettings()).toEqual(DEFAULT_PLATFORM_SETTINGS);
    expect(cache.readThrough).toHaveBeenCalledWith(
      PLATFORM_SETTINGS_CACHE_KEY,
      PLATFORM_SETTINGS_TTL_SECONDS,
      expect.any(Function),
    );
  });

  it('fill the gaps in a row written before a section existed', async () => {
    config.getConfigObject.mockResolvedValue({ kyc: { reviewSlaHours: 12 } });
    const settings = await getPlatformSettings();
    expect(settings.kyc.reviewSlaHours).toBe(12);
    expect(settings.marketplace).toEqual(DEFAULT_PLATFORM_SETTINGS.marketplace);
  });

  it('stand in for a row that does not parse, rather than a partial document', async () => {
    config.getConfigObject.mockResolvedValue({ marketplace: { minBookingDays: 'soon' } });
    expect(await getPlatformSettings()).toEqual(DEFAULT_PLATFORM_SETTINGS);
  });
});

describe('what a PUT may carry', () => {
  it('takes any subset of any section', () => {
    expect(platformSettingsPatchSchema.safeParse({}).success).toBe(true);
    expect(platformSettingsPatchSchema.safeParse({ kyc: { reviewSlaHours: 24 } }).success).toBe(true);
    expect(
      platformSettingsPatchSchema.safeParse({ support: { sla: { HIGH: { resolutionHours: 12 } } } }).success,
    ).toBe(true);
  });

  it('refuses an unknown key, an out-of-range number and a bad enum', () => {
    expect(platformSettingsPatchSchema.safeParse({ kcy: { reviewSlaHours: 24 } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ kyc: { reviewSlaHour: 24 } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ marketplace: { minBookingDays: 0 } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ installation: { commissionMode: 'HOURLY' } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ finance: { primaryRail: 'PAYTM' } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ finance: { primaryRail: 'CASHFREE', clearingDays: 3 } }).success).toBe(true);
  });

  it('Lot K2: takes either authenticator switch alone, strictly', () => {
    expect(platformSettingsPatchSchema.safeParse({ auth: { adminTwoFactor: { authenticatorRequired: true } } }).success).toBe(true);
    expect(platformSettingsPatchSchema.safeParse({ auth: { adminTwoFactor: { smsAllowedWhenEnrolled: false } } }).success).toBe(true);
    expect(platformSettingsPatchSchema.safeParse({ auth: { adminTwoFactor: { totpRequired: true } } }).success).toBe(false);
    expect(platformSettingsPatchSchema.safeParse({ auth: { adminTwoFactor: { authenticatorRequired: 'yes' } } }).success).toBe(false);
  });
});

describe('the merge', () => {
  it('lays objects over objects and leaves untouched keys alone', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: 3 }, { a: { c: 9 } })).toEqual({ a: { b: 1, c: 9 }, d: 3 });
  });

  it('writes the whole validated document and invalidates the readers cache', async () => {
    config.getConfigObject.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS as unknown as Record<string, unknown>);

    const { before, after } = await updatePlatformSettings({
      marketplace: { minBookingDays: 7 },
      listings: { autoPublishOnVerification: false },
    });

    expect(before.marketplace.minBookingDays).toBe(1);
    expect(after.marketplace).toEqual({ minBookingDays: 7, maxMarketsPerCampaign: 3 });
    expect(after.listings.autoPublishOnVerification).toBe(false);
    // The row stored is the document, not the patch.
    expect(config.saveConfigObject).toHaveBeenCalledWith(PLATFORM_SETTINGS_KEY, after);
    expect(after.support.sla).toEqual(DEFAULT_PLATFORM_SETTINGS.support.sla);
    expect(cache.invalidate).toHaveBeenCalledWith(PLATFORM_SETTINGS_CACHE_KEY);
  });

  it('keeps the other three SLAs when one priority is retimed', async () => {
    config.getConfigObject.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS as unknown as Record<string, unknown>);
    const { after } = await updatePlatformSettings({ support: { sla: { HIGH: { resolutionHours: 12 } } } });
    expect(after.support.sla.HIGH).toEqual({ firstResponseHours: 4, resolutionHours: 12 });
    expect(after.support.sla.URGENT).toEqual({ firstResponseHours: 1, resolutionHours: 4 });
  });
});

describe('the audit shape', () => {
  it('flattens to dotted leaves, so a diff names the field that moved', () => {
    const flat = flattenSettings(DEFAULT_PLATFORM_SETTINGS as unknown as Record<string, unknown>);
    expect(flat['kyc.reviewSlaHours']).toBe(48);
    expect(flat['support.sla.URGENT.firstResponseHours']).toBe(1);
    expect(flat['installation.commissionMode']).toBe('FLAT');
  });
});

/* ── Lot J2: the subscription purchase rules ──────────────────────── */

describe('the subscription policies (Lot J2)', () => {
  const policy = (audience: 'publisher' | 'advertiser') => DEFAULT_PLATFORM_SETTINGS.subscriptions[audience];

  it("default to today's behaviour for both audiences, so nothing changed on the day they landed", () => {
    for (const audience of ['publisher', 'advertiser'] as const) {
      expect(policy(audience)).toMatchObject({
        cyclesOffered: ['MONTHLY', 'ANNUAL'],
        annualDiscountPct: 20,
        changePolicy: 'REPLACE_NOW',
        prorateOnChange: false,
        graceDays: 0,
        reminderLeadDays: 7,
        unpaidOrderExpiryDays: 7,
        payment: { walletAllowed: true, gatewaysAllowed: ['RAZORPAY', 'CASHFREE', 'CCAVENUE'] },
        autoRenew: { allowed: false, chargeFromWallet: true },
      });
    }
    // Every tier of each catalogue starts with no trial.
    expect(policy('publisher').trialDays).toEqual({ STANDARD: 0, PLUS: 0, PRO: 0 });
    expect(policy('advertiser').trialDays).toEqual({ STARTER: 0, GROWTH: 0, PRO: 0 });
    // GST is not a policy field — it is revenue's tax row.
    expect(Object.keys(policy('publisher'))).not.toContain('gstPct');
  });

  it('are served through getSubscriptionPolicy, narrowed to the audience', async () => {
    expect(await getSubscriptionPolicy('advertiser')).toEqual(policy('advertiser'));
  });

  it('take a strict partial patch — a tier of trialDays, a switch, a gateway list', () => {
    const ok = (patch: unknown) => platformSettingsPatchSchema.safeParse(patch).success;
    expect(ok({ subscriptions: { publisher: { trialDays: { PLUS: 14 } } } })).toBe(true);
    expect(ok({ subscriptions: { advertiser: { changePolicy: 'QUEUE_AFTER_TERM', prorateOnChange: true } } })).toBe(true);
    expect(ok({ subscriptions: { publisher: { payment: { gatewaysAllowed: [] } } } })).toBe(true);
    expect(ok({ subscriptions: { publisher: { autoRenew: { allowed: true } } } })).toBe(true);
    expect(ok({ subscriptions: { publisher: { cyclesOffered: ['ANNUAL'] } } })).toBe(true);
  });

  it('refuse an empty cycle list, an unknown gateway, a discount past 90, a grace past 90 days, a renewal off the wallet and an unknown key', () => {
    const ok = (patch: unknown) => platformSettingsPatchSchema.safeParse(patch).success;
    expect(ok({ subscriptions: { publisher: { cyclesOffered: [] } } })).toBe(false);
    expect(ok({ subscriptions: { publisher: { cyclesOffered: ['WEEKLY'] } } })).toBe(false);
    expect(ok({ subscriptions: { advertiser: { payment: { gatewaysAllowed: ['PAYTM'] } } } })).toBe(false);
    expect(ok({ subscriptions: { advertiser: { annualDiscountPct: 95 } } })).toBe(false);
    expect(ok({ subscriptions: { advertiser: { graceDays: 91 } } })).toBe(false);
    expect(ok({ subscriptions: { advertiser: { trialDays: { pro: 7 } } } })).toBe(false);
    expect(ok({ subscriptions: { publisher: { autoRenew: { chargeFromWallet: false } } } })).toBe(false);
    expect(ok({ subscriptions: { publisher: { gstPct: 18 } } })).toBe(false);
    expect(ok({ subscriptions: { agent: { graceDays: 1 } } })).toBe(false);
  });

  it('merge a trialDays patch tier by tier and keep the other audience untouched', async () => {
    config.getConfigObject.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS as unknown as Record<string, unknown>);
    const { after } = await updatePlatformSettings({ subscriptions: { publisher: { trialDays: { PLUS: 14 }, graceDays: 3 } } });
    expect(after.subscriptions.publisher.trialDays).toEqual({ STANDARD: 0, PLUS: 14, PRO: 0 });
    expect(after.subscriptions.publisher.graceDays).toBe(3);
    expect(after.subscriptions.publisher.payment).toEqual(DEFAULT_PLATFORM_SETTINGS.subscriptions.publisher.payment);
    expect(after.subscriptions.advertiser).toEqual(DEFAULT_PLATFORM_SETTINGS.subscriptions.advertiser);
    // The dotted leaf an audit row names.
    expect(flattenSettings(after as unknown as Record<string, unknown>)['subscriptions.publisher.trialDays.PLUS']).toBe(14);
  });

  it('replace a gateway list whole — an empty list closes the gateway path', async () => {
    config.getConfigObject.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS as unknown as Record<string, unknown>);
    const { after } = await updatePlatformSettings({ subscriptions: { advertiser: { payment: { gatewaysAllowed: [] } } } });
    expect(after.subscriptions.advertiser.payment).toEqual({ walletAllowed: true, gatewaysAllowed: [] });
  });
});
