import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-5 (17 Sep 2026) — a spot goes live once its publisher's BASICS are in;
 * the identity check no longer holds it back.
 *
 * QR-2 (a day earlier) had `publishListing` refuse 409 `KYC_REQUIRED` for
 * any publisher not VERIFIED. The owner's rule since: a publisher may use
 * the account unverified and list once name, email, address and date of
 * birth are on file — the listing and the profile are marked unverified
 * and ranked below the verified when an advertiser browses. Pinned: a
 * PENDING, NEEDS_INFO or REJECTED publisher with the basics publishes;
 * a publisher missing a basic — even a VERIFIED one — is 409
 * `PROFILE_INCOMPLETE` naming what is missing in `details.missing`; a
 * listing that carries no publisher (an ADX-owned row) is not gated; the
 * gate runs after the rate-card and city gates, so their refusals keep
 * their own codes.
 */

const { repository, pricing, rateCards } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findPublisherById: vi.fn(),
    publish: vi.fn(),
  },
  pricing: {
    assertCityAllows: vi.fn(),
    classifySpot: vi.fn(),
    activeSurge: vi.fn(),
    cityKeyFor: async () => null,
    withCityKey: async (data: unknown) => data,
  },
  rateCards: { assertPublishable: vi.fn(), checkGate: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../rate-cards', () => rateCards);
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant: vi.fn() }));

import { ApiError } from '../../../shared/errors';
import { assertPublisherBasics, publishListing } from '../listings.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  publisherId: 'pub_1',
  status: 'PENDING_REVIEW',
  verifiedAt: null,
  city: 'Bengaluru',
  cityId: 'city_bengaluru',
  ...over,
});

const publisher = (kycStatus: string, over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_1',
  agentId: null,
  kycStatus,
  name: 'Asha Rao',
  mobile: '+919876543210',
  email: 'asha@example.com',
  address: '12 MG Road, Bengaluru',
  dateOfBirth: new Date('1990-04-12T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  pricing.assertCityAllows.mockResolvedValue(undefined);
  rateCards.assertPublishable.mockResolvedValue(undefined);
  rateCards.checkGate.mockResolvedValue({ state: 'CLEAR' });
  repository.findById.mockResolvedValue(listing());
  repository.publish.mockImplementation(async (id: string) => ({ ...listing(), id, status: 'ACTIVE' }));
});

describe('publishListing — the basics gate', () => {
  it.each(['VERIFIED', 'PENDING', 'NEEDS_INFO', 'REJECTED'])('publishes a %s publisher\'s spot once the basics are in', async (state) => {
    repository.findPublisherById.mockResolvedValue(publisher(state));
    await expect(publishListing('lst_1')).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(repository.publish).toHaveBeenCalledWith('lst_1');
  });

  it.each([
    ['email', { email: null }],
    ['address', { address: '  ' }],
    ['dateOfBirth', { dateOfBirth: null }],
    ['name', { name: '+919876543210' }],
  ])('refuses 409 PROFILE_INCOMPLETE naming a missing %s — even for a verified publisher', async (key, over) => {
    repository.findPublisherById.mockResolvedValue(publisher('VERIFIED', over));
    let caught: unknown;
    try {
      await publishListing('lst_1');
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).statusCode).toBe(409);
    expect((caught as ApiError).code).toBe('PROFILE_INCOMPLETE');
    expect((caught as ApiError).details).toEqual({ missing: [key] });
    expect((caught as ApiError).message).not.toContain('KYC');
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('does not gate a listing that carries no publisher', async () => {
    repository.findById.mockResolvedValue(listing({ publisherId: null }));
    await expect(publishListing('lst_1')).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(repository.findPublisherById).not.toHaveBeenCalled();
  });

  it('runs after the rate-card and city gates, so their refusals keep their own codes', async () => {
    repository.findPublisherById.mockResolvedValue(publisher('PENDING', { email: null }));
    rateCards.assertPublishable.mockRejectedValue(new ApiError(409, 'BELOW_RATE_CARD_FLOOR', 'below the floor'));
    await expect(publishListing('lst_1')).rejects.toMatchObject({ code: 'BELOW_RATE_CARD_FLOOR' });
    expect(repository.findPublisherById).not.toHaveBeenCalled();
  });
});

describe('assertPublisherBasics', () => {
  it('404s an unknown publisher and passes a complete one silently', async () => {
    repository.findPublisherById.mockResolvedValue(null);
    await expect(assertPublisherBasics('pub_x')).rejects.toMatchObject({ statusCode: 404 });
    repository.findPublisherById.mockResolvedValue(publisher('PENDING'));
    await expect(assertPublisherBasics('pub_1')).resolves.toBeUndefined();
  });

  it('names every missing basic at once', async () => {
    repository.findPublisherById.mockResolvedValue(publisher('PENDING', { email: null, address: null, dateOfBirth: null }));
    await expect(assertPublisherBasics('pub_1')).rejects.toMatchObject({
      code: 'PROFILE_INCOMPLETE',
      details: { missing: ['email', 'address', 'dateOfBirth'] },
    });
  });
});
