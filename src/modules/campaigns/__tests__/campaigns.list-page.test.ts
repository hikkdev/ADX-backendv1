import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — Advertiser · Campaigns · List (`4417:1689`) and DR 10's
 * `/campaigns` worklist (`5102:26294`).
 *
 * The list had a status facet and a search but no sort, no page past the
 * first, and no total — so an advertiser with 250 campaigns could never reach
 * the 201st, and neither screen could print "5 awaiting approval" or label a
 * chip.
 *
 * `listCampaigns` (array) is kept for the two analytics callers that fold over
 * the whole set; the API reads `listCampaignsPage`.
 */

const { repository } = vi.hoisted(() => ({
  repository: { listCampaignsPage: vi.fn() },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));

import { listCampaignsPage } from '../campaigns.service';
import { CAMPAIGN_STATUSES, listCampaignsQuerySchema } from '../campaigns.schema';

const ADMIN = { userId: 'usr_admin', isAdmin: true, advertiserId: null, agentId: null };
const ADVERTISER = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };

beforeEach(() => {
  vi.clearAllMocks();
  repository.listCampaignsPage.mockResolvedValue({
    items: [{ id: 'cmp_1', name: 'Diwali Season Push', status: 'LIVE' }],
    total: 7,
    counts: { LIVE: 2, DRAFT: 4, COMPLETED: 1 },
  });
});

describe('the campaigns list query', () => {
  it('knows the seven campaign statuses', () => {
    expect(CAMPAIGN_STATUSES).toHaveLength(7);
    expect(CAMPAIGN_STATUSES).toContain('PENDING_PAYMENT');
  });

  it('keeps the comma-list status facet the chips send', () => {
    expect(listCampaignsQuerySchema.parse({ status: 'LIVE,SCHEDULED' }).status).toEqual([
      'LIVE',
      'SCHEDULED',
    ]);
  });

  it('offers the sorts both frames draw', () => {
    for (const sort of ['NEWEST', 'OLDEST', 'BUDGET_DESC', 'ENDING_SOON', 'NAME']) {
      expect(listCampaignsQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(listCampaignsQuerySchema.safeParse({ sort: 'SPEND' }).success).toBe(false);
  });

  it('still accepts `search`, the name the apps already send', () => {
    // Renaming it to `q` in one step would have made both apps' campaign lists
    // silently unfiltered, which is worse than carrying an alias.
    expect(listCampaignsQuerySchema.parse({ search: 'diwali' }).search).toBe('diwali');
    expect(listCampaignsQuerySchema.parse({ q: 'diwali' }).q).toBe('diwali');
  });

  it('caps the page', () => {
    expect(listCampaignsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
});

describe('listCampaignsPage', () => {
  it('scopes an advertiser to their own campaigns', async () => {
    await listCampaignsPage(ADVERTISER, listCampaignsQuerySchema.parse({}));
    expect(repository.listCampaignsPage).toHaveBeenCalledWith(
      expect.objectContaining({ advertiserId: 'adv_1' }),
    );
  });

  it('scopes an admin to everything', async () => {
    await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({}));
    const filter = repository.listCampaignsPage.mock.calls[0]![0];
    expect(filter.advertiserId).toBeUndefined();
    expect(filter.agentId).toBeUndefined();
  });

  it('folds `search` onto the canonical `q` so the repository sees one field', async () => {
    await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({ search: 'diwali' }));
    expect(repository.listCampaignsPage).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'diwali' }),
    );
  });

  it('answers a page with its total and chip counts', async () => {
    const page = await listCampaignsPage(ADMIN, listCampaignsQuerySchema.parse({}));
    expect(page.total).toBe(7);
    expect(page.counts).toEqual({ LIVE: 2, DRAFT: 4, COMPLETED: 1 });
    expect(page.items).toHaveLength(1);
  });
});
