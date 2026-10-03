import { describe, expect, it } from 'vitest';
import { createListingSchema, updateListingSchema } from '../listings.schema';

/**
 * LF-2 (28 Sep 2026): the website's listing questions became the flow's, so
 * every surface sends them. The owner: "I don't want any difference between
 * how website flow works and how app flow works." These pin what the body
 * may now carry — the audience profile as words, the cancellation policy
 * beside its days.
 */

const base = { title: 'Gym mirror decal', category: 'INDOOR', address: 'MG Road, Bengaluru', pricingUnit: 'PER_DAY', basePrice: '1500' };

const restored = {
  installationByAdx: true,
  vehicleModel: 'City bus',
  broadcastLanguage: 'Kannada',
  contentFormat: 'Music and entertainment',
  audienceDemographics: { ageBand: '25–34', genderSplit: 'Balanced', urbanRural: 'Urban', secProfile: 'SEC A / B', incomeBracket: '₹6 – 12 lakh', occupation: 'Office workers' },
  availableYearRound: false,
  maxBookingDays: 90,
  advanceBookingDays: 0,
  cancellationPolicy: 'NOTICE',
  cancellationNoticeDays: 14,
  rateCardValidFrom: '2026-10-01',
  rateCardValidTo: '2027-03-31',
  seasonalVariationNote: 'Higher in the festive season (Oct – Dec)',
  photos: [
    { url: 'https://files.example/front.jpg', type: 'FRONT' },
    { url: 'https://files.example/left.jpg', type: 'LEFT' },
    { url: 'https://files.example/right.jpg', type: 'RIGHT' },
    { url: 'https://files.example/wide.jpg', type: 'WIDE' },
  ],
};

describe('the restored listing questions', () => {
  it('are taken on create, the audience profile as words', () => {
    const parsed = createListingSchema.safeParse({ ...base, ...restored });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.audienceDemographics).toEqual(restored.audienceDemographics);
    expect(parsed.success && parsed.data.cancellationPolicy).toBe('NOTICE');
    expect(parsed.success && parsed.data.advanceBookingDays).toBe(0);
    expect(parsed.success && parsed.data.availableYearRound).toBe(false);
  });

  it('still take the audience as shares, as before', () => {
    expect(createListingSchema.safeParse({ ...base, audienceDemographics: { '18–24': 30, '25–34': 70 } }).success).toBe(true);
    expect(createListingSchema.safeParse({ ...base, audienceDemographics: [{ label: '18–24', share: 30 }] }).success).toBe(true);
  });

  it('take the two policies that are not a number of days, and refuse one that is not a policy', () => {
    expect(createListingSchema.safeParse({ ...base, cancellationPolicy: 'FLEXIBLE' }).success).toBe(true);
    expect(createListingSchema.safeParse({ ...base, cancellationPolicy: 'NONE' }).success).toBe(true);
    expect(createListingSchema.safeParse({ ...base, cancellationPolicy: 'SOMETIMES' }).success).toBe(false);
  });

  it('are patched and cleared like the other extras', () => {
    expect(updateListingSchema.safeParse({ cancellationPolicy: 'FLEXIBLE', audienceDemographics: { ageBand: '55+' } }).success).toBe(true);
    expect(updateListingSchema.safeParse({ cancellationPolicy: null, audienceDemographics: null }).success).toBe(true);
  });

  // The two report kinds the documents door takes are pinned in supply's own tests (lf2-document-kinds).
});
