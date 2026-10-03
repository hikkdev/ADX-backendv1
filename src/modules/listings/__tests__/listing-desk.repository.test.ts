import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 3 Oct 2026: the listing page's reads on the database side.
 *
 *  - the record is ONE `findUnique` with the page's includes, every person
 *    joined through a `select` (never a whole User row);
 *  - the insights are one raw aggregate per read — every metric in one
 *    `UNION ALL`, the listing id and the window bound as parameters, never
 *    spliced into the text;
 *  - occupancy reads the slot-holding orders and the publisher's blocks,
 *    never the live reservations.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    listing: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    uploadedFile: { findMany: vi.fn() },
    customFieldValue: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    listingBlockedDate: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { ADMIN_RECORD_INCLUDE } from '../listing-desk.repository';
import { prismaListingDeskRepository as repository } from '../prisma-listing-desk.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$queryRaw.mockResolvedValue([]);
});

const PERSON_RELATIONS = ['reviewedBy', 'submittedBy', 'decidedBy', 'createdBy', 'assignedTo'];

/** Every `select` under a relation that names a user. */
function peopleSelects(tree: unknown, path = ''): { path: string; keys: string[] }[] {
  if (!tree || typeof tree !== 'object') return [];
  const out: { path: string; keys: string[] }[] = [];
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    if (PERSON_RELATIONS.includes(key)) {
      out.push({ path: `${path}.${key}`, keys: Object.keys((value as { select: object }).select) });
    }
    out.push(...peopleSelects(value, `${path}.${key}`));
  }
  return out;
}

describe('the record read', () => {
  it('is one findUnique with the page’s includes', async () => {
    prisma.listing.findUnique.mockResolvedValue(null);
    await repository.findRecordForAdmin('lst_1');
    expect(prisma.listing.findUnique).toHaveBeenCalledTimes(1);
    // The desk alone opts back into the listing's private columns; the service drops the token itself.
    expect(prisma.listing.findUnique).toHaveBeenCalledWith({
      where: { id: 'lst_1' },
      include: ADMIN_RECORD_INCLUDE,
      omit: { qrToken: false, vehicleRcPayload: false },
    });
  });

  it('joins every person by id and name alone, and the publisher without their business file', () => {
    const people = peopleSelects(ADMIN_RECORD_INCLUDE);
    expect(people.length).toBeGreaterThan(4);
    for (const { keys } of people) expect([...keys].sort()).toEqual(['id', 'name']);
    expect(Object.keys(ADMIN_RECORD_INCLUDE.publisher.select).sort()).toEqual(['city', 'displayId', 'id', 'isPartnerPublisher', 'name', 'type']);
    expect(Object.keys(ADMIN_RECORD_INCLUDE.agent.select.user.select)).toEqual(['name']);
  });

  it('asks nothing of the register or the users table when there is nothing to look up', async () => {
    expect(await repository.userNamesById([])).toEqual([]);
    expect(await repository.photoStamps([])).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.uploadedFile.findMany).not.toHaveBeenCalled();
  });

  it('names the users and the photographs’ stamps in one query each', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.uploadedFile.findMany.mockResolvedValue([]);
    await repository.userNamesById(['usr_1', 'usr_1', 'usr_2']);
    await repository.photoStamps([{ url: 'https://cdn/a.jpg' }]);
    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { id: { in: ['usr_1', 'usr_2'] } }, select: { id: true, name: true } });
    expect(prisma.uploadedFile.findMany.mock.calls[0]![0].select).toEqual({
      id: true,
      url: true,
      takenAt: true,
      latitude: true,
      longitude: true,
      accuracyM: true,
      geoStamped: true,
    });
  });

  it('LD-1: matches a photograph by its upload id where it has one, by the indexed URL only where it has not', async () => {
    prisma.uploadedFile.findMany.mockResolvedValue([]);
    await repository.photoStamps([
      { url: 'https://cdn/a.jpg', uploadedFileId: 'upl_a' },
      { url: 'https://cdn/b.jpg', uploadedFileId: null },
      { url: 'https://cdn/a.jpg', uploadedFileId: 'upl_a' },
    ]);
    expect(prisma.uploadedFile.findMany.mock.calls[0]![0].where).toEqual({
      OR: [{ id: { in: ['upl_a'] } }, { url: { in: ['https://cdn/b.jpg'] } }],
    });
  });
});

describe('the insights reads', () => {
  const sqlOf = () => prisma.$queryRaw.mock.calls[0]![0] as { strings: readonly string[]; values: readonly unknown[]; sql: string };

  it('is one aggregate over every metric, with the listing and the window bound as parameters', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { metric: 'saves', day: '2026-10-01', count: 2n, sum: null },
      { metric: 'gmv', day: '2026-10-01', count: 1n, sum: '1200.5' },
      { metric: 'nonsense', day: '2026-10-01', count: 1n, sum: null },
    ]);
    const span = { start: new Date('2026-09-27T18:30:00Z'), end: new Date('2026-10-03T18:30:00Z') };
    const rows = await repository.insightDays('lst_1', span, { fromDay: '2026-09-28', toDay: '2026-10-03' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const query = sqlOf();
    for (const metric of ['saves', 'bookings', 'bookedValue', 'scans', 'clicks', 'enquiries', 'landingViews', 'reviews', 'gmv']) {
      expect(query.sql + JSON.stringify(query.values)).toContain(metric);
    }
    expect(query.sql).toContain('UNION ALL');
    expect(query.sql).not.toContain('lst_1');
    expect(query.values).toContain('lst_1');
    expect(query.values).toContain(span.start);
    expect(query.values).toContain('2026-09-28');
    expect(rows).toEqual([
      { metric: 'saves', day: '2026-10-01', count: 2, sum: null },
      { metric: 'gmv', day: '2026-10-01', count: 1, sum: '1200.50' },
    ]);
  });

  it('the lifetime read is the same aggregate with no day and no window', async () => {
    prisma.$queryRaw.mockResolvedValue([{ metric: 'bookings', count: 3n, sum: null }]);
    expect(await repository.insightLifetime('lst_1')).toEqual([{ metric: 'bookings', count: 3, sum: null }]);
    const query = sqlOf();
    expect(query.sql).not.toContain('GROUP BY');
    expect(query.sql).not.toContain('AS day');
  });

  it('occupancy reads the orders that hold a slot and the publisher’s blocks, never a reservation', async () => {
    prisma.order.findMany.mockResolvedValue([
      { listingId: 'lst_1', startDate: new Date('2026-10-01'), endDate: new Date('2026-10-02'), campaignSpot: { quantity: 2 } },
    ]);
    prisma.listingBlockedDate.findMany.mockResolvedValue([
      { listingId: 'lst_1', from: new Date('2026-10-03'), to: new Date('2026-10-03'), listing: { slotsTotal: 2 } },
    ]);
    const holds = await repository.occupancyHolds('lst_1', { from: new Date('2026-10-01'), to: new Date('2026-10-04') });
    expect(holds).toEqual([
      { listingId: 'lst_1', quantity: 2, from: new Date('2026-10-01'), to: new Date('2026-10-02') },
      { listingId: 'lst_1', quantity: 2, from: new Date('2026-10-03'), to: new Date('2026-10-03'), blocked: true },
    ]);
    expect(prisma.order.findMany.mock.calls[0]![0].where).toMatchObject({ listingId: 'lst_1' });
  });
});
