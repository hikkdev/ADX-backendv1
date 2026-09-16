import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E: the publisher's side of pricing factors, and what a rejected price
 * case does to a listing.
 *
 * An ADVISORY factor ADX applied is an offer. The publisher reads it at
 * `GET /listings/me/:id/suggested-rate` and, on `accept-suggested-rate`, the
 * rate is written as their own decision — through `updateListing`, so it is
 * the same write a typed rate makes. A rejected CARD_REVISION case reaches
 * `unpublishListing` through rate-cards' port: ACTIVE goes INACTIVE, audited,
 * and the publisher is told.
 */

const { repository, pricing, rateCards, logActivity, createNotification } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    update: vi.fn(),
    findWithPublisher: vi.fn(),
    findAllForAdmin: vi.fn(),
  },
  pricing: {
    suggestedRate: vi.fn(),
    factorProposals: vi.fn(),
    activeSurge: vi.fn(),
    classifySpot: vi.fn(),
    assertCityAllows: vi.fn(),
    // Lot X-B: the city key beside the typed city.
    cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
    withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }),
  },
  rateCards: { belowFloorFlags: vi.fn(), assertPublishable: vi.fn(), checkGate: vi.fn() },
  logActivity: vi.fn(),
  createNotification: vi.fn(),
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../rate-cards', () => rateCards);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant: vi.fn() }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(), ...passThroughFeatureGates() }));
vi.mock('../../notifications', () => ({ createNotification }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity,
}));

import { acceptSuggestedRate, getAllListings, suggestedRateOffer, unpublishListing } from '../listings.service';
import { adminListingsQuerySchema } from '../listings.schema';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  publisherId: 'pub_1',
  title: 'MG Road hoarding',
  status: 'ACTIVE',
  ratePerDay: '10000.00',
  pricingUnit: 'PER_DAY',
  basePrice: '10000.00',
  latitude: 12.97,
  longitude: 77.59,
  city: 'Bengaluru',
  availableNow: true,
  ...over,
});

const offer = () => ({
  base: '10000.00',
  ratePerDay: '11500.00',
  compoundMultiplier: '1.15',
  cappedOut: false,
  applied: [{ name: 'Corner site', kind: 'MULTIPLIER', value: '1.15', mode: 'ADVISORY' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(listing());
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => listing(patch));
  repository.findWithPublisher.mockResolvedValue({ ...listing(), publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null } });
  pricing.suggestedRate.mockResolvedValue(offer());
  pricing.activeSurge.mockResolvedValue(null);
  createNotification.mockResolvedValue(undefined);
});

describe('the suggested-rate offer', () => {
  it('puts the current rate beside the offer and says whether it differs', async () => {
    const view = await suggestedRateOffer('lst_1');
    expect(view).toMatchObject({
      listingId: 'lst_1',
      currentRatePerDay: '10000.00',
      offer: offer(),
      differs: true,
    });
  });

  it('reports no difference once the rate matches the offer', async () => {
    repository.findById.mockResolvedValue(listing({ ratePerDay: '11500.00' }));
    expect((await suggestedRateOffer('lst_1')).differs).toBe(false);
  });
});

describe('accepting the offer', () => {
  it('writes the rate as the publisher own decision, through the ordinary update', async () => {
    const updated = await acceptSuggestedRate('lst_1', 'usr_pub');
    expect(repository.update).toHaveBeenCalledWith(
      'lst_1',
      expect.objectContaining({ ratePerDay: '11500.00', pricingUnit: 'PER_DAY', basePrice: '11500.00' })
    );
    expect(updated.ratePerDay).toBe('11500.00');
    expect(logActivity).toHaveBeenCalledWith(
      'usr_pub',
      'LISTING_SUGGESTED_RATE_ACCEPTED',
      expect.objectContaining({
        targetType: 'Listing',
        targetId: 'lst_1',
        diff: { ratePerDay: { before: '10000.00', after: '11500.00' } },
      })
    );
  });

  it('has nothing to do when the rate already matches', async () => {
    repository.findById.mockResolvedValue(listing({ ratePerDay: '11500.00' }));
    await expect(acceptSuggestedRate('lst_1', 'usr_pub')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('unpublishing on a rejected price case', () => {
  it('takes an ACTIVE listing off the market, audited, and tells the publisher', async () => {
    await unpublishListing('lst_1', { reason: 'Under the floor', actorUserId: 'usr_admin' });
    expect(repository.update).toHaveBeenCalledWith('lst_1', { status: 'INACTIVE', availableNow: false });
    expect(logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LISTING_UNPUBLISHED',
      expect.objectContaining({ targetType: 'Listing', targetId: 'lst_1', metadata: expect.objectContaining({ reason: 'Under the floor' }) })
    );
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', type: 'SYSTEM' }));
  });

  it('refuses a listing that is not live — there is nothing to take down', async () => {
    repository.findById.mockResolvedValue(listing({ status: 'DRAFT' }));
    await expect(unpublishListing('lst_1', { reason: 'x', actorUserId: 'usr_admin' })).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.update).not.toHaveBeenCalled();
  });
});

describe('the admin table', () => {
  it('stamps belowFloor on every row from the rate-card gate', async () => {
    repository.findAllForAdmin.mockResolvedValue({
      items: [listing(), listing({ id: 'lst_2' })],
      total: 2,
      counts: { ACTIVE: 2 },
    });
    rateCards.belowFloorFlags.mockResolvedValue({ lst_1: true, lst_2: false });
    const page = await getAllListings(adminListingsQuerySchema.parse({}));
    expect(rateCards.belowFloorFlags).toHaveBeenCalledWith(['lst_1', 'lst_2']);
    expect(page.items.map((row) => (row as { belowFloor: boolean }).belowFloor)).toEqual([true, false]);
  });
});
