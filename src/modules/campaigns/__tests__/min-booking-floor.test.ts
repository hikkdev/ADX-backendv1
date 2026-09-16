import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot A (Q31): `marketplace.minBookingDays` is a floor, not a default.
 *
 * A publisher may ask for longer bookings than ADX does; none may take a
 * shorter one. So the minimum applied at checkout is the larger of the two,
 * and a listing that states nothing falls back to the platform's figure
 * rather than to no minimum at all — which is what it used to do.
 */

const { repository, settings } = vi.hoisted(() => ({
  repository: { listingsByIds: vi.fn(), replaceSpots: vi.fn(), findCampaign: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../app-config', () => settings);
vi.mock('../../revenue', () => ({ quote: vi.fn() }));
vi.mock('../../advertisers', () => ({
  assertCanBook: vi.fn(),
  holdForCampaign: vi.fn(),
  captureCampaignHold: vi.fn(),
  releaseCampaignHold: vi.fn(),
}));
vi.mock('../../orders', () => ({ placeOrder: vi.fn(), notifyAdmins: vi.fn() }));
// Lot D (Q123): the insertion order is accepted on the version live now; these
// tests are about the money, so it has been.
vi.mock('../../agreements', () => ({
  transactionAcceptance: vi.fn(async (kind: string) => ({ kind, accepted: true, templateVersion: 1, currentVersion: 1, current: true })),
}));

vi.mock('../tracking.service', () => ({ issueTrackingCodes: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
// The draft's visit gate lives in `visits`, whose own imports reach past the orders stub above.
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));

import { setCart } from '../checkout.service';

/** A three-day flight: 12th to 14th inclusive. */
const campaign = () =>
  ({
    id: 'cmp_1',
    startDate: new Date('2026-10-12T00:00:00.000Z'),
    endDate: new Date('2026-10-14T00:00:00.000Z'),
    spots: [],
  }) as never;

const listing = (minBookingDays: number | null) => [
  { id: 'lst_1', title: 'MG Road Billboard', ratePerDay: new Decimal('2500'), minBookingDays },
];

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1 } });
  repository.replaceSpots.mockResolvedValue([]);
  repository.findCampaign.mockResolvedValue({ id: 'cmp_1' });
});

describe('the floor under every listing', () => {
  it('lets a short flight through when neither minimum is higher than it', async () => {
    repository.listingsByIds.mockResolvedValue(listing(null));
    await setCart(campaign(), [{ listingId: 'lst_1' }]);
    expect(repository.replaceSpots).toHaveBeenCalledWith('cmp_1', [expect.objectContaining({ days: 3 })]);
  });

  it('refuses a flight under the platform floor even when the listing states none', async () => {
    settings.getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 7 } });
    repository.listingsByIds.mockResolvedValue(listing(null));

    await expect(setCart(campaign(), [{ listingId: 'lst_1' }])).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('7 days or more'),
    });
  });

  it('keeps the publisher figure when it is the higher of the two', async () => {
    settings.getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 2 } });
    repository.listingsByIds.mockResolvedValue(listing(30));

    await expect(setCart(campaign(), [{ listingId: 'lst_1' }])).rejects.toMatchObject({
      message: expect.stringContaining('30 days or more'),
    });
  });

  it('takes the platform figure when it is the higher of the two', async () => {
    settings.getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 14 } });
    repository.listingsByIds.mockResolvedValue(listing(2));

    await expect(setCart(campaign(), [{ listingId: 'lst_1' }])).rejects.toMatchObject({
      message: expect.stringContaining('14 days or more'),
    });
  });
});
