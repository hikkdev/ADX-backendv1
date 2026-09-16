import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q5/Q104) — saved spaces, per advertiser account.
 *
 * What is pinned: a save is keyed by the advertiser, not the person tapping
 * (an agent under a grant saves into the advertiser's book); a spot that is
 * not live cannot be saved; unsaving asks nothing about whether it was saved;
 * and the list is the browse card, paged as a list.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findActiveById: vi.fn(),
    saveListing: vi.fn(),
    unsaveListing: vi.fn(),
    findSavedForAdvertiser: vi.fn(),
    savedListingIds: vi.fn(),
  },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));

import { listSavedListings, saveListing, unsaveListing } from '../browse.service';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0001',
  title: 'MG Road',
  category: 'OUTDOOR',
  subType: null,
  address: 'MG Road',
  city: 'Bengaluru',
  latitude: null,
  longitude: null,
  ratePerDay: '1000',
  pricingUnit: 'PER_DAY',
  basePrice: '1000',
  widthFt: null,
  heightFt: null,
  size: null,
  photos: [],
  description: null,
  illumination: null,
  facing: null,
  placement: null,
  visibility: null,
  estimatedDailyFootfall: null,
  availableNow: true,
  availableFrom: null,
  availableHoursFrom: null,
  availableHoursTo: null,
  peakPeriodNote: null,
  targetAudience: null,
  uniqueSellingPoint: null,
  ratingAvg: null,
  reviewCount: 0,
  instantBooking: false,
  publisher: { name: 'Suraj' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findActiveById.mockResolvedValue(spot());
  repository.saveListing.mockResolvedValue(undefined);
  repository.unsaveListing.mockResolvedValue(undefined);
  repository.savedListingIds.mockResolvedValue([]);
});

describe('saving', () => {
  it('keys the save by the advertiser and answers the card with saved: true', async () => {
    const card = await saveListing('adv_1', 'lst_1');
    expect(repository.saveListing).toHaveBeenCalledWith('adv_1', 'lst_1');
    expect(card).toMatchObject({ id: 'lst_1', saved: true });
  });

  it('refuses a spot that is not live', async () => {
    repository.findActiveById.mockResolvedValue(null);
    await expect(saveListing('adv_1', 'lst_x')).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.saveListing).not.toHaveBeenCalled();
  });

  it('unsaves without asking whether it was saved', async () => {
    await expect(unsaveListing('adv_1', 'lst_1')).resolves.toEqual({ saved: false });
    expect(repository.unsaveListing).toHaveBeenCalledWith('adv_1', 'lst_1');
  });
});

describe('the list', () => {
  it('is a list page of browse cards, every one marked saved', async () => {
    repository.findSavedForAdvertiser.mockResolvedValue({ items: [spot({ id: 'a' }), spot({ id: 'b' })], total: 7 });
    const page = await listSavedListings('adv_1', { page: 2, pageSize: 2 });
    expect(repository.findSavedForAdvertiser).toHaveBeenCalledWith('adv_1', 2, 2);
    expect(page).toMatchObject({ total: 7, page: 2, pageSize: 2, counts: {} });
    expect(page.items.map((card) => [card.id, card.saved])).toEqual([['a', true], ['b', true]]);
  });
});
