import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 / DR 10 — the admin listings table.
 *
 * Before this, `GET /listings` had no query surface at all: the handler never
 * touched `req.query` and the repository was a bare `findMany` joining every
 * publisher, every agent and every photo, unbounded and uncounted. The screen
 * DR 10 draws (`5102:37197`) has a search box, a review-status filter, three
 * sortable columns, rows-per-page and a "1-5 of 5" range, and none of it could
 * be built.
 *
 * What is pinned here: the query is parsed rather than cast, the page is
 * bounded, the total and the chip counts travel with the items, and the
 * status histogram is counted WITHOUT the status facet so selecting one chip
 * does not zero the others.
 */

const { repository, belowFloorFlags } = vi.hoisted(() => ({
  repository: { findAllForAdmin: vi.fn() },
  belowFloorFlags: vi.fn(async () => ({})),
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
// Lot E: every row is stamped with the rate-card badge; not this suite's subject.
vi.mock('../../rate-cards', () => ({ belowFloorFlags, assertPublishable: vi.fn(), checkGate: vi.fn() }));

import { getAllListings } from '../listings.service';
import { adminListingsQuerySchema } from '../listings.schema';

const page = (over: Record<string, unknown> = {}) => ({
  items: [{ id: 'lst_1', title: 'MG Road Billboard', status: 'PENDING_REVIEW' }],
  total: 5,
  counts: { PENDING_REVIEW: 5, ACTIVE: 12, DRAFT: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  belowFloorFlags.mockResolvedValue({});
  repository.findAllForAdmin.mockResolvedValue(page());
});

describe('the admin listings query', () => {
  it('defaults to the first page, newest first, with nothing filtered', () => {
    const parsed = adminListingsQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.sort).toBe('NEWEST');
    expect(parsed.status).toBeUndefined();
    expect(parsed.city).toBeUndefined();
    expect(parsed.category).toBeUndefined();
  });

  it('takes the review-status filter as a comma list of real ListingStatus values', () => {
    expect(adminListingsQuerySchema.parse({ status: 'PENDING_REVIEW,ACTIVE' }).status).toEqual([
      'PENDING_REVIEW',
      'ACTIVE',
    ]);
  });

  it('refuses a status the enum does not hold, rather than handing it to Postgres', () => {
    // The failure this prevents: `GET /orders` casts its status `as any`, so a
    // typo arrives as an invalid enum and surfaces as a 500 instead of a 400.
    expect(adminListingsQuerySchema.safeParse({ status: 'PENDING_REVEIW' }).success).toBe(false);
  });

  it('offers the sort keys the DR 10 table draws and no others', () => {
    for (const sort of ['NEWEST', 'OLDEST', 'RATE_ASC', 'RATE_DESC', 'TITLE', 'SUBMITTED']) {
      expect(adminListingsQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(adminListingsQuerySchema.safeParse({ sort: 'PUBLISHER' }).success).toBe(false);
  });

  it('caps the page so the table cannot ask for every listing in the database', () => {
    expect(adminListingsQuerySchema.safeParse({ pageSize: '5000' }).success).toBe(false);
  });

  it('carries city and category as their own facets', () => {
    const parsed = adminListingsQuerySchema.parse({ city: ' Bengaluru ', category: 'OUTDOOR' });
    expect(parsed.city).toBe('Bengaluru');
    expect(parsed.category).toBe('OUTDOOR');
  });
});

describe('getAllListings', () => {
  it('hands the parsed query straight to the repository', async () => {
    const query = adminListingsQuerySchema.parse({ q: 'mg road', status: 'ACTIVE', page: '2', pageSize: '10' });
    await getAllListings(query);
    expect(repository.findAllForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'mg road', status: ['ACTIVE'], page: 2, pageSize: 10 }),
    );
  });

  it('returns the page whole — items, total and the chip counts together', async () => {
    const result = await getAllListings(adminListingsQuerySchema.parse({}));
    expect(result.total).toBe(5);
    expect(result.counts).toEqual({ PENDING_REVIEW: 5, ACTIVE: 12, DRAFT: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('reports an empty result as an empty page, not as a missing one', async () => {
    repository.findAllForAdmin.mockResolvedValue({ items: [], total: 0, counts: {} });
    const result = await getAllListings(adminListingsQuerySchema.parse({ q: 'nothing matches this' }));
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
