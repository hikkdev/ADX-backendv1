import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q114) — the booking calendar, listings first.
 *
 * What is pinned: `GET /orders/calendar` is a read over ACTIVE listings —
 * every spot in the filter appears, a spot with nothing booked included —
 * each carrying the orders overlapping the window; the window defaults to
 * the next thirty days from today and refuses a `to` before `from` or a
 * span past a year; the answer is the list contract, chips by listing
 * category counted with the category facet removed; and each order row is
 * the six fields the grid draws (id, campaign, status, from, to, slot).
 */

const { repository } = vi.hoisted(() => ({
  repository: { findCalendar: vi.fn(), countCalendarByCategory: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));

import { getBookingCalendar } from '../orders.queries';
import { calendarQuerySchema } from '../orders.schema';

const from = new Date('2026-10-01T00:00:00.000Z');
const to = new Date('2026-10-31T23:59:59.999Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0001',
  title: 'MG Road digital screen',
  city: 'Bengaluru',
  category: 'OUTDOOR',
  slotsTotal: 6,
  orders: [
    {
      id: 'ord_1',
      status: 'IN_PROGRESS',
      campaignName: 'Monsoon',
      startDate: new Date('2026-10-03T00:00:00Z'),
      endDate: new Date('2026-10-17T00:00:00Z'),
      slotTime: new Date('2026-10-02T09:00:00Z'),
      campaignSpot: { campaign: { id: 'cmp_1', reference: 'CMP-0001', name: 'Monsoon 2026' } },
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCalendar.mockResolvedValue({ items: [row(), row({ id: 'lst_2', displayId: 'LST-0002', title: 'Empty wall', slotsTotal: 1, orders: [] })], total: 2 });
  repository.countCalendarByCategory.mockResolvedValue({ INDOOR: 0, OUTDOOR: 2, TRANSIT: 0, MEDIA: 0 });
});

describe('the calendar query', () => {
  it('defaults the window to the next thirty days from today', () => {
    const parsed = calendarQuerySchema.parse({});
    expect(parsed.from.getUTCHours()).toBe(0);
    expect(parsed.to.getTime() - parsed.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000 - 1);
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });

  it('takes both bounds, and refuses a window that runs backwards or past a year', () => {
    const parsed = calendarQuerySchema.parse({ from: from.toISOString(), to: to.toISOString(), city: 'Bengaluru', category: 'OUTDOOR', q: 'MG' });
    expect(parsed).toMatchObject({ from, to, city: 'Bengaluru', category: 'OUTDOOR', q: 'MG' });
    expect(calendarQuerySchema.safeParse({ from: to.toISOString(), to: from.toISOString() }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2027-06-01T00:00:00Z' }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ category: 'BILLBOARD' }).success).toBe(false);
    expect(calendarQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });

  it('runs thirty days from the start when only a start is given', () => {
    const parsed = calendarQuerySchema.parse({ from: from.toISOString() });
    expect(parsed.to.getTime() - parsed.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000 - 1);
  });
});

describe('getBookingCalendar', () => {
  it('is listings first: every active spot in the filter, the empty ones too, on the list contract', async () => {
    const query = calendarQuerySchema.parse({ from: from.toISOString(), to: to.toISOString(), category: 'OUTDOOR', page: '1', pageSize: '20' });
    const page = await getBookingCalendar(query);
    expect(repository.findCalendar).toHaveBeenCalledWith(query);
    // Chips by category, the category facet removed.
    expect(repository.countCalendarByCategory).toHaveBeenCalledWith({ ...query, category: undefined });
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20, counts: { OUTDOOR: 2, INDOOR: 0 } });
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({ listing: { id: 'lst_2', title: 'Empty wall', slotsTotal: 1 }, orders: [] });
  });

  it('draws each order as the six fields the grid needs, the campaign resolved through its spot', async () => {
    const page = await getBookingCalendar(calendarQuerySchema.parse({ from: from.toISOString(), to: to.toISOString() }));
    expect(page.items[0]!.listing).toEqual({ id: 'lst_1', displayId: 'LST-0001', title: 'MG Road digital screen', city: 'Bengaluru', category: 'OUTDOOR', slotsTotal: 6 });
    expect(page.items[0]!.orders).toEqual([
      {
        id: 'ord_1',
        campaign: { id: 'cmp_1', reference: 'CMP-0001', name: 'Monsoon 2026' },
        status: 'IN_PROGRESS',
        from: '2026-10-03T00:00:00.000Z',
        to: '2026-10-17T00:00:00.000Z',
        slot: '2026-10-02T09:00:00.000Z',
      },
    ]);
  });

  it('falls back to the order\'s own campaign name when it was not raised from a campaign', async () => {
    repository.findCalendar.mockResolvedValue({
      items: [row({ orders: [{ id: 'ord_2', status: 'PENDING_PUBLISHER', campaignName: 'Direct', startDate: null, endDate: null, slotTime: null, campaignSpot: null }] })],
      total: 1,
    });
    const page = await getBookingCalendar(calendarQuerySchema.parse({}));
    expect(page.items[0]!.orders[0]).toEqual({ id: 'ord_2', campaign: { id: null, reference: null, name: 'Direct' }, status: 'PENDING_PUBLISHER', from: null, to: null, slot: null });
  });
});
