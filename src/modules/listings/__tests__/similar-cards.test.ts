import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — `GET /listings/:id/similar` answers browse cards, the shape
 * `GET /listings/browse` answers, not raw listing rows (a public route that
 * used to hand out every column). The website's "similar spaces" grid
 * draws them directly. `:id` is the spot's id or its display id.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findById: vi.fn(), findActiveByDisplayId: vi.fn(), findSimilar: vi.fn(), slotsHeld: vi.fn(async () => new Map()), datedHolds: vi.fn(async () => []) },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../pricing', () => ({ citySupport: vi.fn(), cityKeyFor: async () => null }));

import { similarListings } from '../browse.service';

const row = (id: string) => ({
  id,
  displayId: `LST-${id}`,
  title: `Spot ${id}`,
  category: 'OUTDOOR',
  subType: 'Hoarding',
  address: 'MG Road',
  city: 'Bengaluru',
  latitude: 12.97,
  longitude: 77.6,
  ratePerDay: '1000',
  pricingUnit: 'PER_DAY',
  basePrice: '1000',
  widthFt: '20',
  heightFt: '10',
  size: null,
  photos: [{ url: `https://cdn.adx.in/${id}.jpg`, type: 'main' }],
  description: null,
  illumination: 'Front-lit',
  publisherId: 'pub_1',
  publisher: { name: 'Sharma Media', kycStatus: 'VERIFIED', user: { avatarUrl: null } },
  mediaType: null,
  slotsTotal: 1,
  monthlyPrice: 30000,
  internalNotes: 'never on a card',
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockImplementation(async (id: string) => (id === 'lst_1' ? row('lst_1') : null));
  repository.findActiveByDisplayId.mockImplementation(async (id: string) => (id === 'LST-lst_1' ? row('lst_1') : null));
  repository.findSimilar.mockResolvedValue([row('lst_2'), row('lst_3')]);
});

describe('GET /listings/:id/similar', () => {
  it('answers browse cards — photos, publisher, slots left — and no raw columns', async () => {
    const cards = await similarListings('lst_1');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      id: 'lst_2',
      displayId: 'LST-lst_2',
      photos: ['https://cdn.adx.in/lst_2.jpg'],
      publisherName: 'Sharma Media',
      publisherVerified: true,
      size: '20 × 10 ft',
      slotsLeft: 1,
      saved: false,
    });
    expect(cards[0]).not.toHaveProperty('internalNotes');
    expect(cards[0]).not.toHaveProperty('monthlyPrice');
  });

  it('takes the display id too; an unknown spot is 404', async () => {
    await expect(similarListings('LST-lst_1')).resolves.toHaveLength(2);
    await expect(similarListings('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
