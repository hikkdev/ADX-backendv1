import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../shared/database';

/**
 * The console's listing page (3 Oct 2026) — the owner: "I need to see
 * everything what we store on a listing", and "I don't see any analytical
 * stats for every listing".
 *
 * Pinned:
 *  - the record: every column less the site QR's token (`hasSiteQr`
 *    instead), the photographs cover first with the register's capture
 *    stamp (a GPS fix only when the camera stamped one), every bare user id
 *    named from one lookup, the custom fields, the history counts; 404;
 *  - the insights window: the last thirty Indian days by default, the
 *    previous window the same length before it, `to` before `from` and a
 *    span past a year refused;
 *  - occupancy: booked slot-days over the slot-days the spot was on the
 *    market and not blocked, never more than its slots;
 *  - the insights read folds the day rows into the overviews' figures and
 *    series, the lifetime rows into totals, and says spot-page views are
 *    not recorded rather than drawing a zero.
 */

const desk = vi.hoisted(() => ({
  findRecordForAdmin: vi.fn(),
  userNamesById: vi.fn(),
  photoStamps: vi.fn(),
  customFieldValuesFor: vi.fn(),
  boostsFor: vi.fn(),
  insightFacts: vi.fn(),
  insightDays: vi.fn(),
  insightLifetime: vi.fn(),
  occupancyHolds: vi.fn(),
}));
vi.mock('../prisma-listing-desk.repository', () => ({ prismaListingDeskRepository: desk }));
vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: {} }));

import { getListingRecordForAdmin, listingInsights, occupancyOver, resolveInsightWindow } from '../listing-desk.service';

const D = (value: string | number) => new Prisma.Decimal(value);

const recordRow = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-2509-2601',
  title: 'MG Road hoarding',
  subType: null,
  description: 'A forty-foot wall facing the junction.',
  qrToken: 'tok_secret_123',
  suspendedById: 'usr_ops',
  mediaType: { name: 'Vinyl', formatGroup: 'Print' },
  photos: [
    { id: 'ph_left', url: 'https://cdn/left.jpg', type: 'LEFT', createdAt: new Date('2026-09-01T00:00:00Z'), listingId: 'lst_1' },
    { id: 'ph_front', url: 'https://cdn/front.jpg', type: 'FRONT', createdAt: new Date('2026-09-02T00:00:00Z'), listingId: 'lst_1' },
    { id: 'ph_wide', url: 'https://cdn/wide.jpg', type: 'WIDE', createdAt: new Date('2026-09-03T00:00:00Z'), listingId: 'lst_1' },
  ],
  pricingFactors: [{ id: 'lpf_1', decidedById: 'usr_pricing', applied: true, factor: { id: 'pf_1', name: 'Junction', mode: 'ADVISORY', kind: 'MULTIPLIER' } }],
  priceApprovals: [{ id: 'pa_1', requestedById: 'usr_pub', decidedById: null, status: 'PENDING' }],
  blockedDates: [{ id: 'blk_1', from: new Date('2026-10-10'), to: new Date('2026-10-12'), reason: 'Festival', createdById: 'usr_pub' }],
  _count: { orders: 4, photos: 3, documents: 2 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  desk.userNamesById.mockResolvedValue([
    { id: 'usr_ops', name: 'Ops Desk' },
    { id: 'usr_pricing', name: 'Priya Pricing' },
    { id: 'usr_pub', name: 'Pavan Kumar' },
  ]);
  desk.photoStamps.mockResolvedValue([
    { url: 'https://cdn/front.jpg', takenAt: new Date('2026-09-02T05:00:00Z'), latitude: 12.97, longitude: 77.59, accuracyM: 8, geoStamped: true },
    // An unstamped file's columns are not a place.
    { url: 'https://cdn/left.jpg', takenAt: null, latitude: 1, longitude: 2, accuracyM: null, geoStamped: false },
  ]);
  desk.boostsFor.mockResolvedValue({
    items: [{ id: 'bst_1', displayId: 'BST-1', placements: ['SEARCH_TOP'], status: 'LIVE', startDate: new Date('2026-10-01'), endDate: new Date('2026-10-07'), days: 7, total: D('700.00'), paidAt: new Date('2026-09-30'), createdAt: new Date('2026-09-30') }],
    total: 3,
  });
  desk.customFieldValuesFor.mockResolvedValue([{ key: 'landmark', label: 'Nearest landmark', kind: 'TEXT', archived: false, value: 'Metro gate 2', updatedAt: new Date() }]);
});

describe('GET /listings/:id — the whole record for the desk', () => {
  it('never lets the site QR token out, and says whether there is one', async () => {
    desk.findRecordForAdmin.mockResolvedValue(recordRow());
    const record = await getListingRecordForAdmin('lst_1');
    expect(record).not.toHaveProperty('qrToken');
    expect(JSON.stringify(record)).not.toContain('tok_secret_123');
    expect(record.hasSiteQr).toBe(true);
  });

  it('leads with the front photograph, and stamps each with what the register kept', async () => {
    desk.findRecordForAdmin.mockResolvedValue(recordRow());
    const record = await getListingRecordForAdmin('lst_1');
    expect(record.photos.map((photo) => photo.id)).toEqual(['ph_front', 'ph_left', 'ph_wide']);
    expect(record.coverPhotoUrl).toBe('https://cdn/front.jpg');
    expect(record.photos[0]).toMatchObject({ takenAt: new Date('2026-09-02T05:00:00Z'), gps: { latitude: 12.97, longitude: 77.59, accuracyM: 8 } });
    expect(record.photos[1]).toMatchObject({ takenAt: null, gps: null });
    expect(record.photos[2]).toMatchObject({ takenAt: null, gps: null });
    expect(desk.photoStamps).toHaveBeenCalledWith([
      { url: 'https://cdn/left.jpg', uploadedFileId: undefined },
      { url: 'https://cdn/front.jpg', uploadedFileId: undefined },
      { url: 'https://cdn/wide.jpg', uploadedFileId: undefined },
    ]);
  });

  it('LD-1: reads a photograph’s stamp by its upload id when it has one, and keeps its own capture time first', async () => {
    desk.photoStamps.mockResolvedValue([
      { id: 'upl_front', url: 'https://cdn/elsewhere.jpg', takenAt: new Date('2026-09-02T05:00:00Z'), latitude: 12.97, longitude: 77.59, accuracyM: 8, geoStamped: true },
    ]);
    desk.findRecordForAdmin.mockResolvedValue(
      recordRow({
        photos: [
          { id: 'ph_front', url: 'https://cdn/front.jpg', type: 'FRONT', uploadedFileId: 'upl_front', takenAt: null, createdAt: new Date('2026-09-02T00:00:00Z'), listingId: 'lst_1' },
          { id: 'ph_left', url: 'https://cdn/left.jpg', type: 'LEFT', uploadedFileId: null, takenAt: new Date('2026-09-01T09:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z'), listingId: 'lst_1' },
        ],
      }),
    );
    const record = await getListingRecordForAdmin('lst_1');
    expect(desk.photoStamps).toHaveBeenCalledWith([
      { url: 'https://cdn/front.jpg', uploadedFileId: 'upl_front' },
      { url: 'https://cdn/left.jpg', uploadedFileId: null },
    ]);
    expect(record.photos[0]).toMatchObject({ id: 'ph_front', takenAt: new Date('2026-09-02T05:00:00Z'), gps: { latitude: 12.97, longitude: 77.59, accuracyM: 8 } });
    expect(record.photos[1]).toMatchObject({ id: 'ph_left', takenAt: new Date('2026-09-01T09:00:00Z'), gps: null });
  });

  it('names every bare user id from one lookup, and carries the custom fields and the counts', async () => {
    desk.findRecordForAdmin.mockResolvedValue(recordRow());
    const record = await getListingRecordForAdmin('lst_1');
    expect(desk.userNamesById).toHaveBeenCalledTimes(1);
    expect(desk.userNamesById.mock.calls[0]![0]).toEqual(expect.arrayContaining(['usr_ops', 'usr_pricing', 'usr_pub']));
    expect(record.suspendedBy).toEqual({ id: 'usr_ops', name: 'Ops Desk' });
    expect(record.pricingFactors[0]).toMatchObject({ decidedBy: { id: 'usr_pricing', name: 'Priya Pricing' } });
    expect(record.priceApprovals[0]).toMatchObject({ requestedBy: { id: 'usr_pub', name: 'Pavan Kumar' }, decidedBy: null });
    expect(record.blockedDates[0]).toMatchObject({ reason: 'Festival', createdBy: { id: 'usr_pub', name: 'Pavan Kumar' } });
    expect(record.customFields).toEqual([expect.objectContaining({ label: 'Nearest landmark', value: 'Metro gate 2' })]);
    expect(record.counts).toEqual({ orders: 4, photos: 3, documents: 2, boosts: 3 });
    expect(record.boosts).toEqual([expect.objectContaining({ displayId: 'BST-1', placements: ['SEARCH_TOP'], status: 'LIVE' })]);
    expect(desk.boostsFor).toHaveBeenCalledWith('lst_1', 10);
    expect(record).not.toHaveProperty('_count');
    expect(record.carriesLoop).toBe(false);
  });

  it('renders stored text exactly as stored — no repair of a replacement character', async () => {
    desk.findRecordForAdmin.mockResolvedValue(recordRow({ title: 'Web test � delete me', placement: 'Lobby �' }));
    const record = await getListingRecordForAdmin('lst_1');
    expect(record.title).toBe('Web test � delete me');
    expect((record as Record<string, unknown>)['placement']).toBe('Lobby �');
  });

  it('404s a listing that does not exist', async () => {
    desk.findRecordForAdmin.mockResolvedValue(null);
    await expect(getListingRecordForAdmin('lst_missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the insights window', () => {
  const now = new Date('2026-10-03T06:00:00Z');

  it('is the last thirty Indian days by default, with the thirty before it', () => {
    const window = resolveInsightWindow({}, now);
    expect(window).toMatchObject({ from: '2026-09-04', to: '2026-10-03', previousFrom: '2026-08-05', previousTo: '2026-09-03' });
    expect(window.days).toHaveLength(30);
    expect(window.previousDays).toHaveLength(30);
    // Indian midnight of the previous window's first day to the end of today.
    expect(window.span).toEqual({ start: new Date('2026-08-04T18:30:00.000Z'), end: new Date('2026-10-03T18:30:00.000Z') });
  });

  it('refuses to before from, and more than a year', () => {
    expect(() => resolveInsightWindow({ from: '2026-10-03', to: '2026-10-01' }, now)).toThrow(/before/);
    expect(() => resolveInsightWindow({ from: '2025-01-01', to: '2026-10-01' }, now)).toThrow(/At most/);
  });
});

describe('occupancy', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('counts booked slot-days over the days on the market and not blocked', () => {
    const holds = [
      { listingId: 'lst_1', quantity: 1, from: at('2026-10-01'), to: at('2026-10-02') },
      { listingId: 'lst_1', quantity: 1, from: at('2026-10-04'), to: at('2026-10-04'), blocked: true },
    ];
    expect(occupancyOver(holds, 1, days, '2026-10-01')).toEqual({ bookedSlotDays: 2, availableSlotDays: 3, rate: 2 / 3, perDay: [1, 1, 0, 0] });
  });

  it('never counts more than the slots, nor days before the spot went live', () => {
    const holds = [{ listingId: 'lst_1', quantity: 5, from: at('2026-10-01'), to: at('2026-10-04') }];
    expect(occupancyOver(holds, 2, days, '2026-10-03')).toEqual({ bookedSlotDays: 4, availableSlotDays: 4, rate: 1, perDay: [0, 0, 2, 2] });
  });

  it('has no rate for a spot that was never on the market', () => {
    expect(occupancyOver([], 1, days, null)).toMatchObject({ availableSlotDays: 0, rate: null });
  });
});

describe('GET /listings/:id/insights', () => {
  const now = new Date('2026-10-03T06:00:00Z');

  beforeEach(() => {
    desk.insightFacts.mockResolvedValue({
      id: 'lst_1',
      slotsTotal: 1,
      publishedAt: new Date('2026-09-01T04:00:00Z'),
      createdAt: new Date('2026-08-20T00:00:00Z'),
      ratingAvg: D('4.20'),
      reviewCount: 5,
    });
    desk.insightDays.mockResolvedValue([
      { metric: 'saves', day: '2026-10-01', count: 2, sum: null },
      { metric: 'saves', day: '2026-08-10', count: 1, sum: null },
      { metric: 'bookings', day: '2026-10-02', count: 1, sum: null },
      { metric: 'bookedValue', day: '2026-10-02', count: 1, sum: '6000.00' },
      { metric: 'scans', day: '2026-10-02', count: 7, sum: null },
      { metric: 'enquiries', day: '2026-10-02', count: 2, sum: null },
      { metric: 'gmv', day: '2026-10-02', count: 1, sum: '1200.00' },
      { metric: 'gmv', day: '2026-10-03', count: 1, sum: '1200.00' },
      { metric: 'reviews', day: '2026-10-02', count: 2, sum: '9' },
      { metric: 'views', day: '2026-10-02', count: 40, sum: null },
      { metric: 'views', day: '2026-10-03', count: 10, sum: null },
      { metric: 'views', day: '2026-08-20', count: 5, sum: null },
      { metric: 'uniqueVisitors', day: '2026-10-02', count: 25, sum: null },
      { metric: 'uniqueVisitors', day: '2026-10-03', count: 8, sum: null },
    ]);
    desk.insightLifetime.mockResolvedValue([
      { metric: 'views', count: 120, sum: null },
      { metric: 'uniqueVisitors', count: 70, sum: null },
      { metric: 'saves', count: 12, sum: null },
      { metric: 'bookings', count: 12, sum: null },
      { metric: 'gmv', count: 40, sum: '48000.00' },
    ]);
    desk.occupancyHolds.mockResolvedValue([
      { listingId: 'lst_1', quantity: 1, from: new Date('2026-10-02T00:00:00Z'), to: new Date('2026-10-03T00:00:00Z') },
    ]);
  });

  it('folds the day rows into the overviews’ figures and series', async () => {
    const insights = await listingInsights('lst_1', {}, now);
    expect(insights).toMatchObject({ from: '2026-09-04', to: '2026-10-03', previousFrom: '2026-08-05', onMarketFrom: '2026-09-01' });
    expect(insights.window.saves).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(insights.window.bookings).toEqual({ value: 1, previous: 0, delta: 1 });
    expect(insights.window.scans.value).toBe(7);
    expect(insights.window.enquiries.value).toBe(2);
    expect(insights.window.bookedValue).toEqual({ value: '6000.00', previous: '0.00', delta: '6000.00' });
    expect(insights.window.gmv.value).toBe('2400.00');
    expect(insights.window.rating.current).toEqual({ average: '4.50', count: 2 });
    expect(insights.window.rating.previous).toEqual({ average: null, count: 0 });
    expect(insights.series.saves.days).toHaveLength(30);
    expect(insights.series.saves.days.find((point) => point.day === '2026-10-01')).toEqual({ day: '2026-10-01', value: 2 });
    expect(insights.series.gmv.days[insights.series.gmv.days.length - 1]).toEqual({ day: '2026-10-03', value: '1200.00' });
  });

  it('counts occupancy over the window and the whole life from the day it went live', async () => {
    const insights = await listingInsights('lst_1', {}, now);
    expect(insights.window.occupancy.current).toEqual({ bookedSlotDays: 2, availableSlotDays: 30, rate: 2 / 30 });
    // Live from 1 Sep: nothing of the previous window before it counts as available.
    expect(insights.window.occupancy.previous).toEqual({ bookedSlotDays: 0, availableSlotDays: 3, rate: 0 });
    expect(insights.lifetime.occupancy).toEqual({ bookedSlotDays: 2, availableSlotDays: 33, rate: 2 / 33 });
    expect(insights.series.occupiedSlots.days[insights.series.occupiedSlots.days.length - 1]).toEqual({ day: '2026-10-03', value: 1 });
  });

  it('reads the lifetime totals and the listing’s own stars', async () => {
    const insights = await listingInsights('lst_1', {}, now);
    expect(insights.lifetime).toMatchObject({ saves: 12, bookings: 12, enquiries: 0, gmv: '48000.00', bookedValue: '0.00', rating: { average: '4.20', count: 5 } });
  });

  it('LD-1: draws the spot page’s views and unique visitors as figures, totals and series — nothing left untracked', async () => {
    const insights = await listingInsights('lst_1', {}, now);
    expect(insights.window.views).toEqual({ value: 50, previous: 5, delta: 45 });
    expect(insights.window.uniqueVisitors).toEqual({ value: 33, previous: 0, delta: 33 });
    expect(insights.lifetime.views).toBe(120);
    expect(insights.lifetime.uniqueVisitors).toBe(70);
    expect(insights.series.views.days).toHaveLength(30);
    expect(insights.series.views.days.find((point) => point.day === '2026-10-02')).toEqual({ day: '2026-10-02', value: 40 });
    expect(insights.series.uniqueVisitors.total).toEqual({ value: 33, previous: 0, delta: 33 });
    expect(insights.untracked).toEqual([]);
    expect(JSON.stringify(insights)).not.toContain('spotPageViews');
  });

  it('asks the repository once for the day rows over both windows', async () => {
    await listingInsights('lst_1', { from: '2026-10-01', to: '2026-10-03' }, now);
    expect(desk.insightDays).toHaveBeenCalledTimes(1);
    expect(desk.insightDays).toHaveBeenCalledWith(
      'lst_1',
      { start: new Date('2026-09-27T18:30:00.000Z'), end: new Date('2026-10-03T18:30:00.000Z') },
      { fromDay: '2026-09-28', toDay: '2026-10-03' },
    );
  });

  it('404s a listing that does not exist', async () => {
    desk.insightFacts.mockResolvedValue(null);
    await expect(listingInsights('lst_missing', {}, now)).rejects.toMatchObject({ statusCode: 404 });
  });
});
