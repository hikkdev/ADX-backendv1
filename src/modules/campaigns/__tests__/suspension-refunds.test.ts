import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * What a suspension owes back — Lot A's STOP_OPEN_WORK, campaign side.
 *
 * The figure is unused days x rate x quantity, summed per campaign, and today
 * counts as unused: a spot that comes down this morning did not run today.
 * Nothing here touches a wallet — a refund is a two-person decision, and this
 * only says what it would be for.
 */

const { repository, advertisers, orders, revenue, tracking } = vi.hoisted(() => ({
  repository: {
    findSpotsByOrderIds: vi.fn(),
    updateSpot: vi.fn(),
    listCampaigns: vi.fn(),
    findCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    findCampaignRefundByCampaign: vi.fn(),
    createCampaignRefund: vi.fn(),
  },
  advertisers: {
    assertCanBook: vi.fn(),
    captureCampaignHold: vi.fn(),
    holdForCampaign: vi.fn(),
    releaseCampaignHold: vi.fn(),
  },
  orders: { placeOrder: vi.fn() },
  revenue: { quote: vi.fn() },
  tracking: { issueTrackingCodes: vi.fn() },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../orders', () => orders);
vi.mock('../../revenue', () => revenue);
vi.mock('../tracking.service', () => tracking);
// The draft's visit gate lives in `visits`, whose own imports reach past the orders stub above.
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));

import { cancelAdvertiserCampaigns, cancelSpotsForOrders, unusedDays } from '../checkout.service';

const NOW = new Date('2026-09-10T12:00:00Z');
const START = new Date('2026-09-01T00:00:00Z');
const END = new Date('2026-09-30T00:00:00Z');

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  campaignId: 'cmp_1',
  listingId: 'lst_1',
  status: 'LIVE',
  ratePerDay: new Decimal('1000.00'),
  quantity: 1,
  days: 30,
  startDate: START,
  endDate: END,
  campaign: {
    id: 'cmp_1',
    reference: 'CMP-1',
    advertiserId: 'adv_1',
    status: 'LIVE',
    startDate: START,
    endDate: END,
    walletHoldId: 'hld_1',
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.updateSpot.mockResolvedValue({});
  repository.updateCampaign.mockResolvedValue({});
  repository.listCampaigns.mockResolvedValue([]);
  repository.findCampaignRefundByCampaign.mockResolvedValue(null);
  repository.createCampaignRefund.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'cref_1', ...data }));
  advertisers.releaseCampaignHold.mockResolvedValue({ released: true });
});

describe('unusedDays', () => {
  it('counts today and every day left, inclusive', () => {
    // 10th to 30th inclusive.
    expect(unusedDays(START, END, NOW)).toBe(21);
  });

  it('is the whole flight when it has not started', () => {
    expect(unusedDays(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-05T00:00:00Z'), NOW)).toBe(5);
  });

  it('is nothing once the flight is over, and nothing without dates', () => {
    expect(unusedDays(START, new Date('2026-09-05T00:00:00Z'), NOW)).toBe(0);
    expect(unusedDays(null, END, NOW)).toBe(0);
  });
});

describe('cancelSpotsForOrders', () => {
  it('cancels each spot and adds the unused days up per campaign, once', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([
      spot(),
      spot({ id: 'spt_2', quantity: 2, ratePerDay: new Decimal('500.00') }),
    ]);

    const refunds = await cancelSpotsForOrders(['ord_1', 'ord_2'], NOW);

    expect(repository.updateSpot).toHaveBeenCalledWith('spt_1', { status: 'CANCELLED' });
    expect(refunds).toHaveLength(1);
    // 21 x 1000 + 21 x 500 x 2 = 21000 + 21000.
    expect(refunds[0]).toMatchObject({
      campaignId: 'cmp_1',
      advertiserId: 'adv_1',
      amount: '42000.00',
      spotIds: ['spt_1', 'spt_2'],
      refundNeeded: true,
    });
  });

  it('says no refund is needed while the money is still only held', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([
      spot({ status: 'BOOKED', campaign: { ...spot().campaign, status: 'SCHEDULED' } }),
    ]);
    const refunds = await cancelSpotsForOrders(['ord_1'], NOW);
    expect(refunds[0]!.refundNeeded).toBe(false);
  });

  it('does not re-cancel a spot that is already cancelled', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([spot({ status: 'CANCELLED' })]);
    await cancelSpotsForOrders(['ord_1'], NOW);
    expect(repository.updateSpot).not.toHaveBeenCalled();
  });

  it('is nothing at all when no order had a spot behind it', async () => {
    repository.findSpotsByOrderIds.mockResolvedValue([]);
    await expect(cancelSpotsForOrders(['ord_1'], NOW)).resolves.toEqual([]);
  });
});

describe('cancelAdvertiserCampaigns', () => {
  it('measures the unused days before cancelling, then cancels through the ordinary path', async () => {
    repository.listCampaigns.mockResolvedValue([{ id: 'cmp_1' }]);
    repository.findCampaign.mockResolvedValue({
      id: 'cmp_1',
      reference: 'CMP-1',
      status: 'LIVE',
      startDate: START,
      endDate: END,
      walletHoldId: 'hld_1',
      spots: [spot(), spot({ id: 'spt_2', status: 'CANCELLED' })],
    });

    const refunds = await cancelAdvertiserCampaigns('adv_1', 'Advertiser suspended', NOW);

    expect(repository.listCampaigns).toHaveBeenCalledWith(
      expect.objectContaining({ advertiserId: 'adv_1', status: ['SCHEDULED', 'LIVE'] }),
    );
    // The already-cancelled spot is not counted twice.
    expect(refunds[0]).toMatchObject({ campaignId: 'cmp_1', amount: '21000.00', refundNeeded: true });
    expect(repository.updateCampaign).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ status: 'CANCELLED' }));
  });

  it('releases a scheduled hold instead of asking for a refund', async () => {
    repository.listCampaigns.mockResolvedValue([{ id: 'cmp_1' }]);
    repository.findCampaign.mockResolvedValue({
      id: 'cmp_1',
      reference: 'CMP-1',
      status: 'SCHEDULED',
      startDate: START,
      endDate: END,
      walletHoldId: 'hld_1',
      spots: [spot({ status: 'BOOKED' })],
    });

    const refunds = await cancelAdvertiserCampaigns('adv_1', 'Advertiser suspended', NOW);

    expect(advertisers.releaseCampaignHold).toHaveBeenCalledWith('hld_1');
    expect(refunds[0]!.refundNeeded).toBe(false);
  });
});
