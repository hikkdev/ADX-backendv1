import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q6/Q105) — instant booking, the publisher's opt-in.
 *
 * What is pinned: the field is accepted on create and on update; switching it
 * on needs the flag (409 FEATURE_OFF) and a publisher with somewhere to send
 * the agent (409 NO_MEETING_PLACE); switching it off needs neither; and the
 * rating snapshot `reviews` writes lands on the two denormalised columns.
 */

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  publisherMeetingPlace: vi.fn(),
  setRatingSnapshot: vi.fn(),
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
/** Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns. */
const cityKeyFor = vi.hoisted(() => async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null));
const withCityKey = vi.hoisted(() => async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }));
vi.mock('../../pricing', () => ({ classifySpot, activeSurge, assertCityAllows, cityKeyFor, withCityKey }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled, ...passThroughFeatureGates() }));

import { createListing, setListingRatingSnapshot, updateListing } from '../listings.service';
import { createListingSchema, updateListingSchema } from '../listings.schema';

const draft = (overrides: Record<string, unknown> = {}) => ({
  publisherId: 'pub_1',
  title: 'Andheri East hoarding',
  category: 'OUTDOOR' as const,
  address: 'Western Express Highway',
  city: 'Mumbai',
  ratePerDay: '1200',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  activeSurge.mockResolvedValue(null);
  classifySpot.mockResolvedValue({ venueTypeId: null, mediaTypeId: null, sizeClassId: null, materialId: null });
  repository.create.mockImplementation(async (data: unknown) => data);
  repository.update.mockImplementation(async (_id: string, data: unknown) => data);
  repository.findById.mockResolvedValue({
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
    instantBooking: false,
  });
  repository.publisherMeetingPlace.mockResolvedValue({ address: '12 Hill Road', city: 'Mumbai', state: 'MH' });
  isFeatureEnabled.mockResolvedValue(true);
});

describe('the schemas', () => {
  it('accept instantBooking on create and on update', () => {
    expect(createListingSchema.parse(draft({ instantBooking: true })).instantBooking).toBe(true);
    expect(updateListingSchema.parse({ instantBooking: false }).instantBooking).toBe(false);
    expect(createListingSchema.safeParse(draft({ instantBooking: 'yes' })).success).toBe(false);
  });
});

describe('switching it on', () => {
  it('writes the column when the flag is on and the publisher has an address', async () => {
    const created = await createListing(draft({ instantBooking: true }));
    expect(isFeatureEnabled).toHaveBeenCalledWith('instant-booking', 'pub_1');
    expect(created).toMatchObject({ instantBooking: true });
    const updated = await updateListing('lst_1', { instantBooking: true });
    expect(updated).toMatchObject({ instantBooking: true });
  });

  it('is 409 FEATURE_OFF while ops keep the switch off', async () => {
    isFeatureEnabled.mockResolvedValue(false);
    await expect(createListing(draft({ instantBooking: true }))).rejects.toMatchObject({ statusCode: 409, code: 'FEATURE_OFF' });
    await expect(updateListing('lst_1', { instantBooking: true })).rejects.toMatchObject({ statusCode: 409, code: 'FEATURE_OFF' });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('is 409 NO_MEETING_PLACE when the publisher has nowhere to send the agent', async () => {
    repository.publisherMeetingPlace.mockResolvedValue({ address: null, city: null, state: null });
    await expect(createListing(draft({ instantBooking: true }))).rejects.toMatchObject({ statusCode: 409, code: 'NO_MEETING_PLACE' });
    await expect(updateListing('lst_1', { instantBooking: true })).rejects.toMatchObject({ statusCode: 409, code: 'NO_MEETING_PLACE' });
  });

  it('takes a city and state where there is no street address, the way the accept screen does', async () => {
    repository.publisherMeetingPlace.mockResolvedValue({ address: '  ', city: 'Mumbai', state: null });
    await expect(createListing(draft({ instantBooking: true }))).resolves.toMatchObject({ instantBooking: true });
  });

  it('switching it off asks nothing of the flag or the address', async () => {
    isFeatureEnabled.mockResolvedValue(false);
    repository.publisherMeetingPlace.mockResolvedValue(null);
    await expect(updateListing('lst_1', { instantBooking: false })).resolves.toMatchObject({ instantBooking: false });
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });
});

describe('the rating snapshot', () => {
  it('lands on the two denormalised columns, as a decimal string', async () => {
    await setListingRatingSnapshot('lst_1', { ratingAvg: '4.33', reviewCount: 3 });
    expect(repository.setRatingSnapshot).toHaveBeenCalledWith('lst_1', { ratingAvg: '4.33', reviewCount: 3 });
  });
});
