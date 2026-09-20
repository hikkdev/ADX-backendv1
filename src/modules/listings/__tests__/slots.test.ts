import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q116/136) — slots.
 *
 * What is pinned: `slotsTotal` is accepted on create and on patch, 1..24; a
 * spot that carries no loop — nothing digital about its sub-type or its media
 * type — is refused above 1 (400) and a digital one is not; the count of
 * slots held over a window is the overlapping slot-holding orders plus the
 * live campaign reservations, per listing; a browse card carries
 * `slotsTotal` and `slotsLeft` for the asked window, clamped at zero, and
 * the window is today when none is asked for.
 */

const repository = vi.hoisted(() => ({
  setAvailability: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  publisherMeetingPlace: vi.fn(),
  mediaTypeLoopHint: vi.fn(),
  slotsHeld: vi.fn(),
  findActive: vi.fn(),
  findActiveById: vi.fn(),
  savedListingIds: vi.fn(),
}));
const classifySpot = vi.hoisted(() => vi.fn());
const activeSurge = vi.hoisted(() => vi.fn());
const assertCityAllows = vi.hoisted(() => vi.fn());
const isFeatureEnabled = vi.hoisted(() => vi.fn());

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
// QR-8: a created listing draws its reference from the LISTING series; stubbed so nothing reaches the database.
vi.mock('../../identifiers', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../identifiers')>()), allocateIdentifier: async () => 'LST-0909-2603' }));
/** Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns. */
const cityKeyFor = vi.hoisted(() => async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null));
const withCityKey = vi.hoisted(() => async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }));
vi.mock('../../pricing', () => ({ classifySpot, activeSurge, assertCityAllows, cityKeyFor, withCityKey }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled, ...passThroughFeatureGates() }));

import { createListing, setListingAvailability, updateListing } from '../listings.service';
import { createListingSchema, updateListingSchema } from '../listings.schema';
import { carriesLoop, slotsHeldFor, todayWindow } from '../slots.service';
import { sumSlotHolds } from '../slot-holds';
import { browseListings, getBrowseListing } from '../browse.service';

const draft = (overrides: Record<string, unknown> = {}) => ({
  publisherId: 'pub_1',
  title: 'Andheri East hoarding',
  category: 'OUTDOOR' as const,
  address: 'Western Express Highway',
  city: 'Mumbai',
  ratePerDay: '1200',
  ...overrides,
});

const existing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  publisherId: 'pub_1',
  pricingUnit: 'PER_DAY',
  basePrice: null,
  widthFt: null,
  heightFt: null,
  areaSqFt: null,
  latitude: null,
  longitude: null,
  city: 'Mumbai',
  category: 'OUTDOOR',
  subType: null,
  mediaTypeId: null,
  slotsTotal: 1,
  instantBooking: false,
  ...over,
});

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0001',
  title: 'MG Road Digital Billboard',
  category: 'OUTDOOR',
  subType: 'Digital screen',
  address: 'MG Road',
  city: 'Bengaluru',
  latitude: null,
  longitude: null,
  ratePerDay: '18000',
  pricingUnit: 'PER_DAY',
  basePrice: '18000',
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
  slotsTotal: 6,
  publisher: { name: 'Suraj' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  activeSurge.mockResolvedValue(null);
  classifySpot.mockResolvedValue({ venueTypeId: null, mediaTypeId: null, sizeClassId: null, materialId: null });
  repository.create.mockImplementation(async (data: unknown) => data);
  repository.update.mockImplementation(async (_id: string, data: unknown) => data);
  repository.findById.mockResolvedValue(existing());
  repository.mediaTypeLoopHint.mockResolvedValue(null);
  repository.slotsHeld.mockResolvedValue(new Map());
  repository.findActive.mockResolvedValue({ items: [spot()], total: 1 });
  repository.findActiveById.mockResolvedValue(spot());
  repository.savedListingIds.mockResolvedValue([]);
  isFeatureEnabled.mockResolvedValue(true);
});

describe('the schemas', () => {
  it('accept slotsTotal 1..24 on create and on patch, and nothing outside it', () => {
    expect(createListingSchema.parse(draft({ slotsTotal: 6 })).slotsTotal).toBe(6);
    expect(updateListingSchema.parse({ slotsTotal: 24 }).slotsTotal).toBe(24);
    expect(createListingSchema.parse(draft()).slotsTotal).toBeUndefined();
    for (const bad of [0, 25, 1.5, '6', -1]) {
      expect(createListingSchema.safeParse(draft({ slotsTotal: bad })).success).toBe(false);
      expect(updateListingSchema.safeParse({ slotsTotal: bad }).success).toBe(false);
    }
  });
});

describe('which spots carry a loop', () => {
  it('is decided by the sub-type or the media type naming a screen, never by the category', () => {
    expect(carriesLoop({ subType: 'Digital screen', mediaType: null })).toBe(true);
    expect(carriesLoop({ subType: 'LED Billboard', mediaType: null })).toBe(true);
    expect(carriesLoop({ subType: null, mediaType: { name: 'Static unipole', formatGroup: 'Digital Displays' } })).toBe(true);
    expect(carriesLoop({ subType: null, mediaType: { name: 'Digital gantry', formatGroup: null } })).toBe(true);
    expect(carriesLoop({ subType: 'Hoarding', mediaType: { name: 'Static unipole', formatGroup: 'Static Formats' } })).toBe(false);
    expect(carriesLoop({ subType: null, mediaType: null })).toBe(false);
    // A "screen" printed on vinyl is not a loop; the word alone is not the test.
    expect(carriesLoop({ subType: 'Screen-printed vinyl', mediaType: null })).toBe(false);
  });
});

describe('creating with slots', () => {
  it('writes slotsTotal on a digital spot', async () => {
    const created = await createListing(draft({ subType: 'Digital screen', slotsTotal: 8 }));
    expect(created).toMatchObject({ slotsTotal: 8 });
  });

  it('reads the loop off the media type the classifier resolved', async () => {
    classifySpot.mockResolvedValue({ venueTypeId: null, mediaTypeId: 'mt_led', sizeClassId: null, materialId: null });
    repository.mediaTypeLoopHint.mockResolvedValue({ name: 'LED wall', formatGroup: 'Digital Displays' });
    await expect(createListing(draft({ slotsTotal: 4 }))).resolves.toMatchObject({ slotsTotal: 4, mediaTypeId: 'mt_led' });
    expect(repository.mediaTypeLoopHint).toHaveBeenCalledWith('mt_led');
  });

  it('refuses more than one slot on a static spot, before anything is written', async () => {
    await expect(createListing(draft({ subType: 'Hoarding', slotsTotal: 3 }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('lets a static spot say 1, and says nothing when the field is absent', async () => {
    await expect(createListing(draft({ slotsTotal: 1 }))).resolves.toMatchObject({ slotsTotal: 1 });
    const created = await createListing(draft());
    expect(created.slotsTotal).toBeUndefined();
    expect(repository.mediaTypeLoopHint).not.toHaveBeenCalled();
  });
});

describe('patching slots', () => {
  it('writes the new count on a digital spot', async () => {
    repository.findById.mockResolvedValue(existing({ subType: 'Digital gantry' }));
    await expect(updateListing('lst_1', { slotsTotal: 4 })).resolves.toMatchObject({ slotsTotal: 4 });
  });

  it('refuses more than one slot on a static spot', async () => {
    await expect(updateListing('lst_1', { slotsTotal: 4 })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses a sub-type change that leaves a multi-slot spot with no loop', async () => {
    repository.findById.mockResolvedValue(existing({ subType: 'Digital gantry', slotsTotal: 4 }));
    await expect(updateListing('lst_1', { subType: 'Hoarding' })).rejects.toMatchObject({ statusCode: 400 });
    // Bringing the count back to 1 in the same patch is fine.
    await expect(updateListing('lst_1', { subType: 'Hoarding', slotsTotal: 1 })).resolves.toMatchObject({ slotsTotal: 1 });
  });

  it('asks nothing of a patch that does not touch the loop', async () => {
    await expect(updateListing('lst_1', { title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed' });
    expect(repository.mediaTypeLoopHint).not.toHaveBeenCalled();
  });
});

describe('slots held', () => {
  it('asks the repository for the window and answers zero for a spot with nothing on it', async () => {
    repository.slotsHeld.mockResolvedValue(new Map([['lst_1', 2]]));
    const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z') };
    const held = await slotsHeldFor(['lst_1', 'lst_2'], window);
    expect(repository.slotsHeld).toHaveBeenCalledWith(['lst_1', 'lst_2'], window);
    expect(held.get('lst_1')).toBe(2);
    expect(held.get('lst_2') ?? 0).toBe(0);
  });

  it('G10: a hold is the quantity booked, not the row — a campaign spot of 3 on a six-slot loop holds three', () => {
    const held = sumSlotHolds({
      orders: [
        { listingId: 'lst_1', campaignSpot: { quantity: 3 } },
        // A direct order carries no campaign spot: one slot.
        { listingId: 'lst_1', campaignSpot: null },
        { listingId: 'lst_2', campaignSpot: { quantity: 1 } },
      ],
      reservations: [
        { listingId: 'lst_1', _sum: { quantity: 2 } },
        { listingId: 'lst_3', _sum: { quantity: null } },
      ],
    });
    expect(held.get('lst_1')).toBe(6);
    expect(held.get('lst_2')).toBe(1);
    expect(held.get('lst_3') ?? 0).toBe(0);
  });

  it('today is the UTC day, start to end', () => {
    const window = todayWindow(new Date('2026-09-13T15:42:00Z'));
    expect(window.from.toISOString()).toBe('2026-09-13T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-09-13T23:59:59.999Z');
  });
});

describe('browse cards', () => {
  it('carry slotsTotal and slotsLeft for the asked window', async () => {
    repository.slotsHeld.mockResolvedValue(new Map([['lst_1', 2]]));
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-14T00:00:00Z');
    const page = await browseListings({ sort: 'NEWEST', from, to });
    expect(page.items[0]).toMatchObject({ slotsTotal: 6, slotsLeft: 4 });
    expect(repository.slotsHeld).toHaveBeenCalledWith(['lst_1'], { from, to });
  });

  it('use today when no window is asked for, and never go below zero', async () => {
    repository.slotsHeld.mockResolvedValue(new Map([['lst_1', 9]]));
    const page = await browseListings({ sort: 'NEWEST' });
    expect(page.items[0]).toMatchObject({ slotsTotal: 6, slotsLeft: 0 });
    const [, window] = repository.slotsHeld.mock.calls[0]!;
    expect(window.from.getUTCHours()).toBe(0);
    expect(window.to.getTime()).toBeGreaterThan(window.from.getTime());
  });

  it('a static spot reads 1 of 1, and 0 left once booked', async () => {
    repository.findActiveById.mockResolvedValue(spot({ subType: null, slotsTotal: 1 }));
    await expect(getBrowseListing('lst_1')).resolves.toMatchObject({ slotsTotal: 1, slotsLeft: 1 });
    repository.slotsHeld.mockResolvedValue(new Map([['lst_1', 1]]));
    const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') };
    await expect(getBrowseListing('lst_1', undefined, window)).resolves.toMatchObject({ slotsTotal: 1, slotsLeft: 0 });
    expect(repository.slotsHeld).toHaveBeenLastCalledWith(['lst_1'], window);
  });
});

describe('the availableNow flag on a loop', () => {
  it('goes off only when the screen is full today, and a static wall flips as before', async () => {
    repository.findById.mockResolvedValue(existing({ subType: 'Digital screen', slotsTotal: 6 }));
    repository.slotsHeld.mockResolvedValue(new Map([['lst_1', 2]]));
    await setListingAvailability('lst_1', false);
    expect(repository.setAvailability).not.toHaveBeenCalled();
    repository.slotsHeld.mockResolvedValue(new Map([['lst_1', 6]]));
    await setListingAvailability('lst_1', false);
    expect(repository.setAvailability).toHaveBeenCalledWith('lst_1', false);
    // Freeing asks nothing.
    await setListingAvailability('lst_1', true);
    expect(repository.setAvailability).toHaveBeenLastCalledWith('lst_1', true);
    // A wall of one flips on the first confirmation.
    repository.findById.mockResolvedValue(existing());
    repository.slotsHeld.mockClear();
    await setListingAvailability('lst_1', false);
    expect(repository.slotsHeld).not.toHaveBeenCalled();
    expect(repository.setAvailability).toHaveBeenLastCalledWith('lst_1', false);
  });
});
