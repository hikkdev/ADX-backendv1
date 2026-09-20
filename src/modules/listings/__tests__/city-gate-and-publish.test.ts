import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two Lot A (Q31) edges on the listing itself.
 *
 * The city gate: a spot cannot be filed in a geography ADX has closed, and
 * can be filed in one ADX has never heard of — the table lists the places ops
 * have an opinion about, not every town in India.
 *
 * The publish door: with auto-publish off, an accepted site visit leaves the
 * listing at AWAITING_SITE_VERIFICATION, so POST /listings/:id/publish has to
 * accept it from there — but only once it really has been verified. The
 * switch asks for a human look at a verified spot, not for a way to skip the
 * site visit.
 */

const { repository, pricing, rateCards } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    publish: vi.fn(),
    setContentRules: vi.fn(),
  },
  pricing: {
    assertCityAllows: vi.fn(),
    classifySpot: vi.fn(),
    activeSurge: vi.fn(),
    // Lot X-B: the city key beside the typed city — Bengaluru (and its old spelling) is catalogued, the rest are typed towns.
    cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
    withCityKey: async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: /^(bengaluru|bangalore)$/i.test((data.city ?? '').trim()) ? 'city_bengaluru' : null }),
  },
  rateCards: { assertPublishable: vi.fn(), checkGate: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
// QR-8: the reference comes off the LISTING series at creation; stubbed so nothing reaches the database.
vi.mock('../../identifiers', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../identifiers')>()), allocateIdentifier: async () => 'LST-0909-2699' }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../rate-cards', () => rateCards);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant: vi.fn() }));

import { ApiError } from '../../../shared/errors';
import { createListing, publishListing } from '../listings.service';

beforeEach(() => {
  vi.clearAllMocks();
  pricing.assertCityAllows.mockResolvedValue(undefined);
  pricing.classifySpot.mockResolvedValue({});
  pricing.activeSurge.mockResolvedValue(null);
  repository.create.mockResolvedValue({ id: 'lst_1' });
  rateCards.assertPublishable.mockResolvedValue(undefined);
  repository.publish.mockImplementation(async (id: string) => ({ id, status: 'ACTIVE' }));
});

const draft = (city: string | undefined) =>
  ({ publisherId: 'pub_1', title: 'MG Road Billboard', city, ratePerDay: '2500' }) as never;

describe('the city gate on create', () => {
  it('asks the city table about the name on the form', async () => {
    await createListing(draft('Bengaluru'));
    expect(pricing.assertCityAllows).toHaveBeenCalledWith('Bengaluru', 'supplyIntake');
    expect(repository.create).toHaveBeenCalled();
  });

  /* Lot X-B: the key beside the typed city. */
  it('stamps the city key on the row — the catalogue row for an old spelling, null for a typed town, nothing without a city', async () => {
    await createListing(draft('Bangalore'));
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bangalore', cityId: 'city_bengaluru' }));
    await createListing(draft('Rameswaram'));
    expect(repository.create).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Rameswaram', cityId: null }));
    await createListing(draft(undefined));
    expect(repository.create).toHaveBeenLastCalledWith(expect.not.objectContaining({ cityId: expect.anything() }));
  });

  it('refuses a closed geography, and never writes the row', async () => {
    pricing.assertCityAllows.mockRejectedValue(
      new ApiError(400, 'CITY_NOT_OPEN', 'ADX is not open for new listings in Kochi (planned).'),
    );
    await expect(createListing(draft('Kochi'))).rejects.toMatchObject({ code: 'CITY_NOT_OPEN' });
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('publishing by hand', () => {
  it('publishes a verified listing that is waiting for a human look', async () => {
    repository.findById.mockResolvedValue({
      id: 'lst_1',
      status: 'AWAITING_SITE_VERIFICATION',
      verifiedAt: new Date('2026-09-12T00:00:00.000Z'),
    });

    await expect(publishListing('lst_1')).resolves.toMatchObject({ status: 'ACTIVE' });
    // The same rate-card gate as any other publication — the switch changes
    // who publishes, not what is checked.
    expect(rateCards.assertPublishable).toHaveBeenCalledWith('lst_1');
  });

  it('refuses one that has not been verified: this is not a way round the site visit', async () => {
    repository.findById.mockResolvedValue({ id: 'lst_1', status: 'AWAITING_SITE_VERIFICATION', verifiedAt: null });
    await expect(publishListing('lst_1')).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('still publishes from DRAFT and PENDING_REVIEW, and still refuses a live one', async () => {
    repository.findById.mockResolvedValue({ id: 'lst_1', status: 'DRAFT', verifiedAt: null });
    await expect(publishListing('lst_1')).resolves.toMatchObject({ status: 'ACTIVE' });

    repository.findById.mockResolvedValue({ id: 'lst_1', status: 'PENDING_REVIEW', verifiedAt: null });
    await expect(publishListing('lst_1')).resolves.toMatchObject({ status: 'ACTIVE' });

    repository.findById.mockResolvedValue({ id: 'lst_1', status: 'ACTIVE', verifiedAt: new Date() });
    await expect(publishListing('lst_1')).rejects.toMatchObject({ statusCode: 400 });
  });

  /* Lot V: a SEEDING city gathers listings but publishes none. */
  it('asks the publishing gate for the city of the listing, after the rate-card gate, and refuses when the stage says no', async () => {
    repository.findById.mockResolvedValue({ id: 'lst_1', status: 'DRAFT', verifiedAt: null, city: 'Mysuru', cityId: 'city_mysuru' });
    await expect(publishListing('lst_1')).resolves.toMatchObject({ status: 'ACTIVE' });
    // Lot X-B: judged by the key the row carries, the spelling beside it.
    expect(pricing.assertCityAllows).toHaveBeenCalledWith('Mysuru', 'publishing', 'city_mysuru');

    pricing.assertCityAllows.mockRejectedValueOnce(new ApiError(400, 'CITY_NOT_OPEN', 'ADX is not open for publishing in Mysuru (seeding).', { stage: 'SEEDING', function: 'publishing', city: 'mysuru' }));
    repository.publish.mockClear();
    await expect(publishListing('lst_1')).rejects.toMatchObject({ code: 'CITY_NOT_OPEN', details: { stage: 'SEEDING', function: 'publishing' } });
    expect(repository.publish).not.toHaveBeenCalled();
  });
});
