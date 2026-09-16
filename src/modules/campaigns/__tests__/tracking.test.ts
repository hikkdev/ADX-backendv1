import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Measurement is only worth having if the count is defensible.
 *
 * Three things decide that here: one code per booked slot rather than one per
 * campaign, so a scan can be attributed to a hoarding; the advertiser's own UTM
 * tags surviving untouched, so their analytics still work; and a link preview
 * fetched by a messaging app never being counted as a person.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    createTrackingCodes: vi.fn(),
    codeExists: vi.fn(),
    findTrackingCode: vi.fn(),
    recordTrackingEvent: vi.fn(),
    bumpTrackingCounter: vi.fn(),
    // Lot E (Q106): a code without a destination looks for the campaign's page.
    findLandingPage: vi.fn(async () => null),
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));

import {
  deviceClass,
  issueTrackingCodes,
  recordRedemptions,
  resolveScan,
  withUtm,
} from '../tracking.service';

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    trackingMethod: 'QR_OR_DEEPLINK',
    trackingConfig: { destinationUrl: 'https://anitascoffee.in/offer', utmCampaign: 'adx-apr26' },
    spots: [{ id: 'spt_1', status: 'BOOKED' }, { id: 'spt_2', status: 'BOOKED' }],
    codes: [],
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.codeExists.mockResolvedValue(false);
  repository.createTrackingCodes.mockImplementation(async (rows) => rows);
  repository.findCampaign.mockResolvedValue(campaign());
});

describe('utm tags', () => {
  it('adds ADX source and medium and the campaign tag', () => {
    const url = new URL(withUtm('https://anitascoffee.in/offer', 'adx-apr26', 'AB12CD34'));
    expect(url.searchParams.get('utm_source')).toBe('adx');
    expect(url.searchParams.get('utm_medium')).toBe('ooh');
    expect(url.searchParams.get('utm_campaign')).toBe('adx-apr26');
    // The code, so the advertiser can see which hoarding sent the visit.
    expect(url.searchParams.get('utm_content')).toBe('AB12CD34');
  });

  /** They had a reason for it, and overwriting it breaks their reporting. */
  it('never overwrites a tag the advertiser set themselves', () => {
    const url = new URL(
      withUtm('https://anitascoffee.in/offer?utm_campaign=mine&utm_source=print', 'adx-apr26', 'X')
    );
    expect(url.searchParams.get('utm_campaign')).toBe('mine');
    expect(url.searchParams.get('utm_source')).toBe('print');
  });

  it('refuses something that is not a URL', () => {
    expect(() => withUtm('anitascoffee', null, 'X')).toThrow();
  });
});

describe('issuing codes', () => {
  it('issues one per booked slot for QR', async () => {
    const codes = await issueTrackingCodes('cmp_1');
    expect(codes).toHaveLength(2);
    expect(codes.map((code) => code.spotId)).toEqual(['spt_1', 'spt_2']);
    expect(new Set(codes.map((code) => code.code)).size).toBe(2);
  });

  it('issues one for the campaign for a promo code', async () => {
    repository.findCampaign.mockResolvedValue(
      campaign({
        trackingMethod: 'VANITY_OR_PROMO',
        trackingConfig: { vanityUrl: 'https://anitascoffee.in/adx', promoCode: 'COFFEE20' },
      })
    );
    const codes = await issueTrackingCodes('cmp_1');
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ spotId: null, promoCode: 'COFFEE20' });
  });

  it('issues nothing for an untracked campaign or a location-lift one', async () => {
    repository.findCampaign.mockResolvedValue(campaign({ trackingMethod: 'NONE' }));
    expect(await issueTrackingCodes('cmp_1')).toEqual([]);

    repository.findCampaign.mockResolvedValue(campaign({ trackingMethod: 'LOCATION_LIFT' }));
    expect(await issueTrackingCodes('cmp_1')).toEqual([]);
  });

  /** Authorization can be retried; a second set of codes would split the counts. */
  it('is idempotent', async () => {
    repository.findCampaign.mockResolvedValue(
      campaign({ codes: [{ id: 'code_1', code: 'AB12CD34' }] })
    );
    await issueTrackingCodes('cmp_1');
    expect(repository.createTrackingCodes).not.toHaveBeenCalled();
  });

  /* Lot D (Q139): the destination is optional. The code still goes on the
     hoarding and the scan still counts; it lands on the plain page. */
  it('issues codes with no destination for a QR campaign with nowhere to send anybody', async () => {
    repository.findCampaign.mockResolvedValue(campaign({ trackingConfig: {} }));
    const codes = await issueTrackingCodes('cmp_1');
    expect(codes).toHaveLength(2);
    for (const code of codes) expect(code.destination).toBeNull();
  });

  it('leaves out a code that reads ambiguously in print', async () => {
    const codes = await issueTrackingCodes('cmp_1');
    for (const { code } of codes) expect(code).not.toMatch(/[01OIL]/);
  });
});

describe('a scan', () => {
  beforeEach(() => {
    repository.findTrackingCode.mockResolvedValue({
      id: 'code_1',
      destination: 'https://anitascoffee.in/offer?utm_source=adx',
      campaign: { id: 'cmp_1', status: 'LIVE' },
    });
  });

  it('records the scan and the redirect, then sends the visitor on', async () => {
    const result = await resolveScan('AB12CD34', {
      userAgent: 'Mozilla/5.0 (iPhone) Mobile Safari',
      referer: null,
      city: 'Bengaluru',
    });

    expect(result).toEqual({
      destination: 'https://anitascoffee.in/offer?utm_source=adx',
      landingSlug: null,
      counted: true,
    });
    expect(repository.bumpTrackingCounter).toHaveBeenCalledWith('code_1', 'scans', 1);
    expect(repository.bumpTrackingCounter).toHaveBeenCalledWith('code_1', 'clicks', 1);
    expect(repository.recordTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SCAN', device: 'mobile', city: 'Bengaluru' })
    );
  });

  /** A WhatsApp link preview is not somebody standing in front of a hoarding. */
  it('follows a bot but does not count it', async () => {
    const result = await resolveScan('AB12CD34', {
      userAgent: 'WhatsApp/2.2 link preview bot',
      referer: null,
      city: null,
    });
    expect(result.counted).toBe(false);
    expect(repository.bumpTrackingCounter).not.toHaveBeenCalled();
    expect(result.destination).toBeTruthy();
  });

  it('still counts a scan when there is nowhere to send them', async () => {
    repository.findTrackingCode.mockResolvedValue({
      id: 'code_1',
      destination: null,
      campaign: { id: 'cmp_1', status: 'LIVE' },
    });
    const result = await resolveScan('AB12CD34', { userAgent: 'iPhone Mobile', referer: null, city: null });
    expect(repository.bumpTrackingCounter).toHaveBeenCalledWith('code_1', 'scans', 1);
    expect(repository.bumpTrackingCounter).not.toHaveBeenCalledWith('code_1', 'clicks', 1);
    expect(result.destination).toBeNull();
  });

  it('404s an unknown code', async () => {
    repository.findTrackingCode.mockResolvedValue(null);
    await expect(
      resolveScan('NOPE', { userAgent: null, referer: null, city: null })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('classifies devices coarsely and nothing finer', () => {
    expect(deviceClass('Mozilla/5.0 (iPhone) Mobile')).toBe('mobile');
    expect(deviceClass('Mozilla/5.0 (iPad)')).toBe('tablet');
    expect(deviceClass('Mozilla/5.0 (Macintosh)')).toBe('desktop');
    expect(deviceClass(null)).toBeNull();
  });
});

describe('redemptions', () => {
  it('records what the advertiser reports against the promo code', async () => {
    repository.findCampaign.mockResolvedValue(
      campaign({
        trackingMethod: 'VANITY_OR_PROMO',
        codes: [{ id: 'code_1', method: 'VANITY_OR_PROMO' }],
      })
    );
    const result = await recordRedemptions('cmp_1', 12);
    expect(result.recorded).toBe(12);
    expect(repository.bumpTrackingCounter).toHaveBeenCalledWith('code_1', 'redemptions', 12);
  });

  it('refuses when the campaign has no promo code', async () => {
    await expect(recordRedemptions('cmp_1', 5)).rejects.toMatchObject({ statusCode: 409 });
  });
});
