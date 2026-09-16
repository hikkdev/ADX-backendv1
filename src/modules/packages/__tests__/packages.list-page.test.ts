import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — Agent Adv · Package Sales · List (`4420:915`).
 *
 * The list had a status facet and a `limit` and nothing else: no search, no
 * sort, no second page, no total. The frame's chips are All / Active /
 * Expiring / Expired, and "expiring" is not a status — it is an ACTIVE plan
 * whose end date is close. So the facet is the shelf the agent sees, the same
 * way the publisher's own listings are shelved by occupancy.
 *
 * `listSales` (array) is kept: `sellPackage` folds over open sales to find a
 * duplicate before creating one, and has no use for a page.
 */

const { repository } = vi.hoisted(() => ({
  repository: { listSalesPage: vi.fn() },
}));

vi.mock('../prisma-packages.repository', () => ({ prismaPackagesRepository: repository }));

import { listSalesPage } from '../packages.service';
import { EXPIRING_WITHIN_DAYS, PACKAGE_SHELVES, listSalesQuerySchema } from '../packages.schema';

const ADMIN = { userId: 'usr_admin', isAdmin: true, advertiserId: null, agentId: null };
const AGENT = { userId: 'usr_agt', isAdmin: false, advertiserId: null, agentId: 'agt_1' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.listSalesPage.mockResolvedValue({
    items: [{ id: 'sale_1', reference: 'PKG-1', packageName: 'Growth' }],
    total: 4,
    counts: { ACTIVE: 2, EXPIRING: 1, EXPIRED: 1 },
  });
});

describe('the package sales query', () => {
  it('draws the three chips the frame draws', () => {
    expect([...PACKAGE_SHELVES]).toEqual(['ACTIVE', 'EXPIRING', 'EXPIRED']);
    for (const shelf of PACKAGE_SHELVES) {
      expect(listSalesQuerySchema.safeParse({ shelf }).success).toBe(true);
    }
    expect(listSalesQuerySchema.safeParse({ shelf: 'CANCELLED' }).success).toBe(false);
  });

  it('states the expiring window rather than hiding it in a query', () => {
    expect(EXPIRING_WITHIN_DAYS).toBe(14);
  });

  it('takes a search and the sorts the card needs', () => {
    expect(listSalesQuerySchema.parse({ q: 'anita' }).q).toBe('anita');
    for (const sort of ['NEWEST', 'OLDEST', 'RENEWAL', 'VALUE_DESC']) {
      expect(listSalesQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(listSalesQuerySchema.safeParse({ sort: 'COMMISSION' }).success).toBe(false);
  });

  it('caps the page', () => {
    expect(listSalesQuerySchema.safeParse({ pageSize: '400' }).success).toBe(false);
    expect(listSalesQuerySchema.parse({}).pageSize).toBe(20);
  });
});

describe('listSalesPage', () => {
  it('scopes an agent to their own book', async () => {
    await listSalesPage(AGENT, listSalesQuerySchema.parse({}));
    expect(repository.listSalesPage).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_1' }));
  });

  it('lets an admin see every sale', async () => {
    await listSalesPage(ADMIN, listSalesQuerySchema.parse({}));
    const filter = repository.listSalesPage.mock.calls[0]![0];
    expect(filter.agentId).toBeUndefined();
    expect(filter.advertiserId).toBeUndefined();
  });

  it('answers a page with the three chip counts', async () => {
    const page = await listSalesPage(ADMIN, listSalesQuerySchema.parse({}));
    expect(page.total).toBe(4);
    expect(page.counts).toEqual({ ACTIVE: 2, EXPIRING: 1, EXPIRED: 1 });
  });
});
