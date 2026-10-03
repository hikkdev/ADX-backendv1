import { describe, expect, it } from 'vitest';
import { shapeAvailability, windowOf } from '../availability.service';

/**
 * BD-1 — the publisher's availability grid, as one read.
 *
 * What is pinned: the window defaults to today and the fortnight after and
 * is capped at a quarter; the repository's rows fold onto the spots in
 * inventory order — an order is BOOKED with the campaign and the
 * advertiser's company, a live reservation is a HOLD, a block carries its
 * reason — and a spot with nothing on it is still a row.
 */
describe('windowOf', () => {
  const now = new Date('2026-10-12T06:30:00Z');

  it('defaults to today and thirteen days after it, to the last millisecond', () => {
    const window = windowOf({}, now);
    expect(window.from.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-10-25T23:59:59.999Z');
  });

  it('takes both bounds, and refuses a reversed or over-long window', () => {
    expect(windowOf({ from: '2026-11-01', to: '2026-11-30' }, now).to.toISOString()).toBe('2026-11-30T23:59:59.999Z');
    expect(() => windowOf({ from: '2026-11-30', to: '2026-11-01' }, now)).toThrow();
    expect(() => windowOf({ from: '2026-01-01', to: '2026-06-01' }, now)).toThrow();
    expect(() => windowOf({ from: 'next week' }, now)).toThrow();
  });
});

describe('shapeAvailability', () => {
  it('folds orders, holds and blocks onto the spots', () => {
    const view = shapeAvailability(
      { from: new Date('2026-10-12T00:00:00Z'), to: new Date('2026-10-25T23:59:59.999Z') },
      {
        listings: [
          { id: 'lst_1', displayId: 'LST-1', title: 'MG Road display', category: 'OUTDOOR', city: 'Bengaluru', slotsTotal: 1, status: 'ACTIVE' },
          { id: 'lst_2', displayId: 'LST-2', title: 'Phoenix Mall Atrium', category: 'INDOOR', city: 'Bengaluru', slotsTotal: 6, status: 'ACTIVE' },
          { id: 'lst_3', displayId: null, title: 'Whitefield East billboard', category: 'OUTDOOR', city: 'Bengaluru', slotsTotal: 1, status: 'PENDING_REVIEW' },
        ],
        orders: [
          {
            id: 'ord_1',
            listingId: 'lst_2',
            status: 'ACCEPTED',
            startDate: new Date('2026-10-12T00:00:00Z'),
            endDate: new Date('2026-10-25T00:00:00Z'),
            campaignName: 'Aster Festive Launch',
            campaignSpot: { campaign: { name: 'Aster Festive Launch' } },
            advertiser: { name: 'Riya Mehta', advertiserProfile: { name: 'Aster Home', companyName: 'Aster Home Pvt Ltd' } },
          },
          { id: 'ord_2', listingId: 'lst_1', status: 'LIVE', startDate: null, endDate: null, campaignName: null, campaignSpot: null, advertiser: { name: 'Walk-in', advertiserProfile: null } },
        ],
        reservations: [{ listingId: 'lst_2', startDate: new Date('2026-10-20T00:00:00Z'), endDate: new Date('2026-10-22T00:00:00Z'), campaign: { name: 'Diwali teaser', advertiser: { name: 'Nykaa', companyName: null } } }],
        blocks: [{ id: 'blk_1', listingId: 'lst_1', from: new Date('2026-10-18T00:00:00Z'), to: new Date('2026-10-19T00:00:00Z'), reason: 'Repainting' }],
      },
    );

    expect(view.from).toBe('2026-10-12');
    expect(view.to).toBe('2026-10-25');
    expect(view.listings.map((l) => l.id)).toEqual(['lst_1', 'lst_2', 'lst_3']);
    expect(view.listings[1]!.bookings).toEqual([
      { orderId: 'ord_1', campaignName: 'Aster Festive Launch', advertiserName: 'Aster Home Pvt Ltd', from: '2026-10-12', to: '2026-10-25', kind: 'BOOKED', status: 'ACCEPTED' },
      { orderId: null, campaignName: 'Diwali teaser', advertiserName: 'Nykaa', from: '2026-10-20', to: '2026-10-22', kind: 'HOLD', status: 'RESERVED' },
    ]);
    // An order without dates occupies the spot outright: both bounds null.
    expect(view.listings[0]!.bookings[0]).toMatchObject({ orderId: 'ord_2', from: null, to: null, advertiserName: 'Walk-in' });
    expect(view.listings[0]!.blocks).toEqual([{ id: 'blk_1', from: '2026-10-18', to: '2026-10-19', reason: 'Repainting' }]);
    expect(view.listings[2]).toMatchObject({ status: 'PENDING_REVIEW', bookings: [], blocks: [] });
  });
});
