import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: the refund desk's rows name the advertiser — `advertiser { id,
 * displayId, name } | null` beside the campaign, joined through the campaign
 * in the one second query the repository already makes, so the desk prints
 * a name and an id instead of an advertiser id. Null when the campaign is
 * gone, the way `campaign` already is.
 */

type Row = Record<string, any>;

const prisma = vi.hoisted(() => ({
  campaignRefund: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn() },
  campaign: { findMany: vi.fn() },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaCampaignsRepository } from '../prisma-campaigns.repository';

const refund = (over: Row = {}): Row => ({ id: 'cref_1', campaignId: 'cmp_1', status: 'PENDING', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.campaignRefund.count.mockResolvedValue(2);
  prisma.campaignRefund.groupBy.mockResolvedValue([{ status: 'PENDING', _count: { _all: 2 } }]);
  prisma.campaign.findMany.mockResolvedValue([
    {
      id: 'cmp_1',
      reference: 'CMP-2026-000001',
      name: 'Diwali',
      advertiserId: 'adv_1',
      status: 'CANCELLED',
      advertiser: { id: 'adv_1', displayId: 'ADV-1209-2601', name: 'Asha Rao' },
    },
  ]);
});

describe('listCampaignRefunds — the advertiser beside the campaign', () => {
  it('carries advertiser { id, displayId, name } from the campaign join, null for a campaign it cannot find', async () => {
    prisma.campaignRefund.findMany.mockResolvedValue([refund(), refund({ id: 'cref_2', campaignId: 'cmp_gone' })]);
    const page = await prismaCampaignsRepository.listCampaignRefunds({ page: 1, pageSize: 20 });
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['cmp_1', 'cmp_gone'] } },
        select: expect.objectContaining({ advertiser: { select: { id: true, displayId: true, name: true } } }),
      }),
    );
    expect(page.items[0]).toMatchObject({
      id: 'cref_1',
      campaign: { id: 'cmp_1', reference: 'CMP-2026-000001', name: 'Diwali', advertiserId: 'adv_1', status: 'CANCELLED' },
      advertiser: { id: 'adv_1', displayId: 'ADV-1209-2601', name: 'Asha Rao' },
    });
    expect(page.items[1]).toMatchObject({ id: 'cref_2', campaign: null, advertiser: null });
    expect(page).toMatchObject({ total: 2, counts: { PENDING: 2, RELEASED: 0, REJECTED: 0 } });
  });

  it('names the advertiser on the single read too', async () => {
    prisma.campaignRefund.findUnique.mockResolvedValue(refund());
    const view = await prismaCampaignsRepository.findCampaignRefund('cref_1');
    expect(view).toMatchObject({ advertiser: { id: 'adv_1', displayId: 'ADV-1209-2601', name: 'Asha Rao' } });
  });
});
