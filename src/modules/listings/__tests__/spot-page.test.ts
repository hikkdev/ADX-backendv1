import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E11-2: the public spot page — `GET /s/:displayId`.
 *
 * What a shared link opens on a phone with no app: one self-contained
 * document with the spot's title, media type, size, rate per day, city and
 * area, the publisher's business name, the rating line when there are
 * reviews, and one "Open in the ADX app" link to the deep link, with the
 * store links from env when they are set. ACTIVE listings only; the hero
 * photograph is drawn through a public URL and never a private file. Every
 * browse card carries `shareUrl`, built from PUBLIC_WEB_URL and falling
 * back to the API origin.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findActive: vi.fn(),
    findActiveById: vi.fn(),
    findActiveByDisplayId: vi.fn(),
    savedListingIds: vi.fn(),
    slotsHeld: vi.fn(async () => new Map()),
  },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));

import { env } from '../../../config/env';
import { browseListings, getBrowseListing, shareUrlFor, toBrowseCard } from '../browse.service';
import { getSpotPage, publicPhotoUrl, renderSpotPage, spotPageLinks } from '../spot-page.service';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'ADX-LST-24018',
  title: 'MG Road Digital Billboard <North>',
  category: 'OUTDOOR',
  subType: 'Digital screen',
  address: 'MG Road, Central Bengaluru',
  city: 'Bengaluru',
  latitude: 12.975,
  longitude: 77.605,
  ratePerDay: '18000',
  pricingUnit: 'PER_DAY',
  basePrice: '18000',
  widthFt: '40',
  heightFt: '20',
  size: null,
  photos: [
    { url: 'https://cdn.adx.in/l/1.jpg', type: 'main' },
    { url: 'https://cdn.adx.in/l/2.jpg', type: 'gallery' },
  ],
  description: 'Strategically located on MG Road.',
  illumination: 'LED',
  facing: 'North-South',
  placement: 'Single-sided unipole',
  visibility: 'High',
  estimatedDailyFootfall: 85000,
  availableNow: true,
  availableFrom: null,
  availableHoursFrom: null,
  availableHoursTo: null,
  peakPeriodNote: null,
  targetAudience: null,
  uniqueSellingPoint: null,
  ratingAvg: '4.50',
  reviewCount: 12,
  instantBooking: false,
  status: 'ACTIVE',
  publisher: { name: 'Suraj Media Pvt Ltd' },
  mediaType: { name: 'Digital billboard' },
  ...over,
});

const mutableEnv = env as unknown as Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  repository.findActive.mockResolvedValue({ items: [spot()], total: 1 });
  repository.findActiveById.mockResolvedValue(spot());
  repository.findActiveByDisplayId.mockResolvedValue(spot());
  repository.savedListingIds.mockResolvedValue([]);
  delete mutableEnv['PUBLIC_WEB_URL'];
  delete mutableEnv['APP_STORE_URL'];
  delete mutableEnv['PLAY_STORE_URL'];
  delete mutableEnv['BASE_URL'];
});

describe('shareUrl on the browse card', () => {
  it('is PUBLIC_WEB_URL + /s/:displayId when the env names one', () => {
    mutableEnv['PUBLIC_WEB_URL'] = 'https://adx.in/';
    expect(shareUrlFor('ADX-LST-24018')).toBe('https://adx.in/s/ADX-LST-24018');
    expect(toBrowseCard(spot() as never).shareUrl).toBe('https://adx.in/s/ADX-LST-24018');
  });

  it('falls back to the API origin', () => {
    mutableEnv['BASE_URL'] = 'https://api.adx.in';
    expect(shareUrlFor('ADX-LST-24018')).toBe('https://api.adx.in/s/ADX-LST-24018');
    delete mutableEnv['BASE_URL'];
    expect(shareUrlFor('ADX-LST-24018')).toBe(`http://localhost:${env.PORT}/s/ADX-LST-24018`);
  });

  it('is null for a spot that has no display id yet', () => {
    expect(shareUrlFor(null)).toBeNull();
    expect(toBrowseCard(spot({ displayId: null }) as never).shareUrl).toBeNull();
  });

  it('rides on the browse page and the single read', async () => {
    mutableEnv['PUBLIC_WEB_URL'] = 'https://adx.in';
    const page = await browseListings({ sort: 'NEWEST' });
    expect(page.items[0]!.shareUrl).toBe('https://adx.in/s/ADX-LST-24018');
    const one = await getBrowseListing('lst_1');
    expect(one.shareUrl).toBe('https://adx.in/s/ADX-LST-24018');
  });
});

describe('the hero photograph', () => {
  it('is a public http(s) URL, never a private file', () => {
    expect(publicPhotoUrl([{ url: 'https://cdn.adx.in/l/1.jpg', type: 'main' }])).toBe('https://cdn.adx.in/l/1.jpg');
    expect(publicPhotoUrl([{ url: 'https://api.adx.in/api/v1/files/abc123', type: 'main' }])).toBeNull();
    expect(publicPhotoUrl([{ url: 'javascript:alert(1)', type: 'main' }])).toBeNull();
    expect(publicPhotoUrl([{ url: '/uploads/x.jpg', type: 'main' }])).toBeNull();
    expect(publicPhotoUrl([])).toBeNull();
  });

  it('prefers the main photograph and skips past one that cannot be shown', () => {
    expect(
      publicPhotoUrl([
        { url: 'https://cdn.adx.in/l/2.jpg', type: 'gallery' },
        { url: 'https://cdn.adx.in/l/1.jpg', type: 'main' },
      ]),
    ).toBe('https://cdn.adx.in/l/1.jpg');
    expect(
      publicPhotoUrl([
        { url: 'https://api.adx.in/api/v1/files/abc123', type: 'main' },
        { url: 'https://cdn.adx.in/l/2.jpg', type: 'gallery' },
      ]),
    ).toBe('https://cdn.adx.in/l/2.jpg');
  });
});

describe('the links', () => {
  it('always has the deep link, and the store links only when env names them', () => {
    expect(spotPageLinks('ADX-LST-24018')).toEqual({ app: 'adx://spaces/ADX-LST-24018', appStore: null, playStore: null });
    mutableEnv['APP_STORE_URL'] = 'https://apps.apple.com/in/app/adx/id1';
    mutableEnv['PLAY_STORE_URL'] = 'https://play.google.com/store/apps/details?id=in.adx';
    expect(spotPageLinks('ADX-LST-24018')).toEqual({
      app: 'adx://spaces/ADX-LST-24018',
      appStore: 'https://apps.apple.com/in/app/adx/id1',
      playStore: 'https://play.google.com/store/apps/details?id=in.adx',
    });
  });
});

describe('the render', () => {
  it('is one self-contained document with the facts the frame prints', () => {
    const html = renderSpotPage(getSpotPageModel(), spotPageLinks('ADX-LST-24018'));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Every string escaped.
    expect(html).toContain('MG Road Digital Billboard &lt;North&gt;');
    expect(html).not.toContain('<North>');
    expect(html).toContain('Digital billboard');
    expect(html).toContain('40 × 20 ft');
    expect(html).toContain('₹18,000');
    expect(html).toContain('per day');
    expect(html).toContain('Bengaluru');
    expect(html).toContain('MG Road, Central Bengaluru');
    expect(html).toContain('Suraj Media Pvt Ltd');
    expect(html).toContain('4.5');
    expect(html).toContain('12 reviews');
    expect(html).toContain('href="adx://spaces/ADX-LST-24018"');
    expect(html).toContain('Open in the ADX app');
    expect(html).toContain('<img class="hero" src="https://cdn.adx.in/l/1.jpg"');
    // No external asset: no stylesheet, script or font from anywhere.
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\s+src/);
    expect(html).not.toContain('@import');
    expect(html).toContain('name="robots"');
  });

  it('leaves the rating line out until somebody has reviewed the spot', () => {
    const html = renderSpotPage(getSpotPageModel({ ratingAvg: null, reviewCount: 0 }), spotPageLinks('ADX-LST-24018'));
    expect(html).not.toContain('reviews');
    expect(html).not.toContain('★');
  });

  it('draws the store links when they are set, and nothing for a store nobody named', () => {
    const withStores = renderSpotPage(getSpotPageModel(), {
      app: 'adx://spaces/ADX-LST-24018',
      appStore: 'https://apps.apple.com/in/app/adx/id1',
      playStore: null,
    });
    expect(withStores).toContain('href="https://apps.apple.com/in/app/adx/id1"');
    expect(withStores).not.toContain('Google Play');
  });

  it('draws no hero when the only photograph is private', () => {
    const html = renderSpotPage(getSpotPageModel({ heroUrl: null }), spotPageLinks('ADX-LST-24018'));
    expect(html).not.toContain('<img');
  });
});

describe('the read', () => {
  it('answers for an ACTIVE listing by its display id', async () => {
    const model = await getSpotPage('ADX-LST-24018');
    expect(repository.findActiveByDisplayId).toHaveBeenCalledWith('ADX-LST-24018');
    expect(model).toMatchObject({
      displayId: 'ADX-LST-24018',
      title: 'MG Road Digital Billboard <North>',
      mediaType: 'Digital billboard',
      size: '40 × 20 ft',
      ratePerDay: '18000.00',
      city: 'Bengaluru',
      area: 'MG Road, Central Bengaluru',
      publisherName: 'Suraj Media Pvt Ltd',
      ratingAvg: '4.50',
      reviewCount: 12,
      heroUrl: 'https://cdn.adx.in/l/1.jpg',
    });
  });

  it('falls back to the category when the spot was filed under no media type', async () => {
    repository.findActiveByDisplayId.mockResolvedValue(spot({ mediaType: null }));
    expect((await getSpotPage('ADX-LST-24018')).mediaType).toBe('Outdoor');
  });

  it('is 404 for anything not ACTIVE, or unknown', async () => {
    repository.findActiveByDisplayId.mockResolvedValue(null);
    await expect(getSpotPage('ADX-LST-99999')).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

function getSpotPageModel(over: Record<string, unknown> = {}) {
  return {
    displayId: 'ADX-LST-24018',
    title: 'MG Road Digital Billboard <North>',
    mediaType: 'Digital billboard',
    size: '40 × 20 ft',
    ratePerDay: '18000.00',
    city: 'Bengaluru',
    area: 'MG Road, Central Bengaluru',
    publisherName: 'Suraj Media Pvt Ltd',
    ratingAvg: '4.50',
    reviewCount: 12,
    heroUrl: 'https://cdn.adx.in/l/1.jpg',
    ...over,
  } as never;
}
