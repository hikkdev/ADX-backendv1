import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PB-1 (the owner, 2 Oct 2026): "Inside orders we are missing an identifier
 * column that can tell us who placed the order or what business."
 *
 * Every row of the admin board, and the admin detail, carries
 *   placedBy: { userId, name, displayId, business: { id, name, displayId } | null }
 * — the login that placed it (`Order.advertiserId`), the person's name (first
 * and last, else the display name) and ADX id, and the advertiser profile that
 * login holds. The board's search finds an order by any of the four.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    order: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { getAllOrders, getOrderPlacedBy, placedByFrom } from '../orders.queries';
import { adminOrdersQuerySchema } from '../orders.schema';

const placer = (over: Record<string, unknown> = {}) => ({
  id: 'usr_adv',
  name: 'asha',
  firstName: 'Asha',
  lastName: 'Rao',
  displayId: 'ADX-0210-2601',
  advertiserProfile: { id: 'adv_1', name: 'Rao Sweets', displayId: 'ADV-0210-2601' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.order.findMany.mockResolvedValue([]);
  prisma.order.count.mockResolvedValue(0);
  prisma.order.groupBy.mockResolvedValue([]);
});

describe('placedByFrom', () => {
  it('names the person by first and last name, and the business by its profile', () => {
    expect(placedByFrom(placer())).toEqual({
      userId: 'usr_adv',
      name: 'Asha Rao',
      displayId: 'ADX-0210-2601',
      business: { id: 'adv_1', name: 'Rao Sweets', displayId: 'ADV-0210-2601' },
    });
  });

  it('falls back to the display name, and answers a null business for a login with no advertiser profile', () => {
    expect(placedByFrom(placer({ firstName: null, lastName: '  ', advertiserProfile: null }))).toEqual({
      userId: 'usr_adv',
      name: 'asha',
      displayId: 'ADX-0210-2601',
      business: null,
    });
  });

  it('takes a first name alone, and a null name when there is nothing to call them', () => {
    expect(placedByFrom(placer({ lastName: null }))?.name).toBe('Asha');
    expect(placedByFrom(placer({ firstName: null, lastName: null, name: null }))?.name).toBeNull();
  });

  it('is null when there is no user row to read', () => {
    expect(placedByFrom(null)).toBeNull();
    expect(placedByFrom(undefined)).toBeNull();
  });
});

describe('GET /orders — placedBy on every row', () => {
  it('shapes the joined login into placedBy and does not leak the join itself', async () => {
    prisma.order.findMany.mockResolvedValue([
      { id: 'ord_1', status: 'IN_PROGRESS', advertiserId: 'usr_adv', advertiser: placer() },
      { id: 'ord_2', status: 'COMPLETED', advertiserId: 'usr_2', advertiser: placer({ id: 'usr_2', advertiserProfile: null }) },
    ]);
    prisma.order.count.mockResolvedValue(2);
    const page = (await getAllOrders(adminOrdersQuerySchema.parse({}))) as { items: Record<string, unknown>[] };
    expect(page.items[0]).toMatchObject({ id: 'ord_1', placedBy: { userId: 'usr_adv', name: 'Asha Rao', business: { id: 'adv_1', displayId: 'ADV-0210-2601' } } });
    expect(page.items[1]).toMatchObject({ id: 'ord_2', placedBy: { userId: 'usr_2', business: null } });
    expect(page.items[0]).not.toHaveProperty('advertiser');
  });

  it('joins only the names, the ADX id and the profile — never the whole user row', async () => {
    await getAllOrders(adminOrdersQuerySchema.parse({}));
    const args = prisma.order.findMany.mock.calls[0]![0];
    expect(args.include.advertiser).toEqual({
      select: {
        id: true,
        name: true,
        firstName: true,
        lastName: true,
        displayId: true,
        advertiserProfile: { select: { id: true, name: true, displayId: true } },
      },
    });
  });

  it('finds an order by the business name, the ADV- id, the person and the ADX- id', async () => {
    await getAllOrders(adminOrdersQuerySchema.parse({ q: 'rao' }));
    const or = prisma.order.findMany.mock.calls[0]![0].where.OR as unknown[];
    const contains = { contains: 'rao', mode: 'insensitive' };
    expect(or).toEqual(
      expect.arrayContaining([
        { advertiser: { name: contains } },
        { advertiser: { firstName: contains } },
        { advertiser: { lastName: contains } },
        { advertiser: { displayId: contains } },
        { advertiser: { advertiserProfile: { is: { name: contains } } } },
        { advertiser: { advertiserProfile: { is: { displayId: contains } } } },
      ]),
    );
    // The old search still stands beside it.
    expect(or).toEqual(expect.arrayContaining([{ campaignName: contains }]));
  });
});

describe('the admin detail — getOrderPlacedBy', () => {
  it('reads the placing login with the same narrow select', async () => {
    prisma.user.findUnique.mockResolvedValue(placer());
    expect(await getOrderPlacedBy('usr_adv')).toMatchObject({ name: 'Asha Rao', business: { name: 'Rao Sweets' } });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'usr_adv' } }));
    expect(prisma.user.findUnique.mock.calls[0]![0].select).not.toHaveProperty('passwordHash');
  });

  it('is null when the login is gone', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    expect(await getOrderPlacedBy('usr_gone')).toBeNull();
  });
});
