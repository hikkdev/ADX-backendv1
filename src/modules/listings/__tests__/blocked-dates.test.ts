import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BD-1 — the dates a publisher takes a spot off the market.
 *
 * What is pinned: the pure rule (`blockProblem`) — the order of the days,
 * the past, a year at most, no overlap with a block already there; the
 * service's own refusals — ownership through `assertCanEditListing`, a
 * booking or hold on the days (409 DATES_BOOKED) — and that a block is
 * written as calendar days, audited, and removed only from its own listing.
 */
const { repository, listings, slots, audit } = vi.hoisted(() => ({
  repository: { findBlockedDates: vi.fn(), findBlockedDate: vi.fn(), createBlockedDate: vi.fn(), deleteBlockedDate: vi.fn() },
  listings: { assertCanEditListing: vi.fn() },
  slots: { slotsHeldFor: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../listings.service', () => listings);
vi.mock('../slots.service', () => slots);
vi.mock('../../../shared/audit', () => audit);

import { addBlockedDate, blockProblem, dayOf, listBlockedDates, removeBlockedDate, windowOfDays } from '../blocked-dates.service';

const actor = { userId: 'usr_pub', isAdmin: false };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'blk_1',
  listingId: 'lst_1',
  from: new Date('2026-10-12T00:00:00Z'),
  to: new Date('2026-10-14T00:00:00Z'),
  reason: 'Repainting',
  createdById: 'usr_pub',
  createdAt: new Date('2026-09-25T10:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listings.assertCanEditListing.mockResolvedValue(undefined);
  repository.findBlockedDates.mockResolvedValue([]);
  repository.createBlockedDate.mockImplementation(async (data: Record<string, unknown>) => row(data));
  repository.deleteBlockedDate.mockResolvedValue({ count: 1 });
  slots.slotsHeldFor.mockResolvedValue(new Map());
  audit.logActivity.mockResolvedValue(undefined);
});

describe('the rule', () => {
  const today = new Date('2026-09-25T09:00:00Z');

  it('reads YYYY-MM-DD as the UTC day and refuses anything else', () => {
    expect(dayOf('2026-10-12').toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(() => dayOf('12/10/2026')).toThrow();
    expect(() => dayOf('2026-02-30')).toThrow();
    expect(windowOfDays(dayOf('2026-10-12'), dayOf('2026-10-12')).to.toISOString()).toBe('2026-10-12T23:59:59.999Z');
  });

  it('refuses reversed days, days behind today, more than a year, and an overlap with a block', () => {
    expect(blockProblem(dayOf('2026-10-14'), dayOf('2026-10-12'), [], today)?.code).toBe('DATES_REVERSED');
    expect(blockProblem(dayOf('2026-09-20'), dayOf('2026-09-24'), [], today)?.code).toBe('DATES_PAST');
    expect(blockProblem(dayOf('2026-10-01'), dayOf('2027-10-02'), [], today)?.code).toBe('DATES_TOO_LONG');
    expect(blockProblem(dayOf('2026-10-13'), dayOf('2026-10-20'), [row()], today)?.code).toBe('DATES_BLOCKED');
    // Touching at the edge is an overlap: the days are inclusive.
    expect(blockProblem(dayOf('2026-10-14'), dayOf('2026-10-20'), [row()], today)?.code).toBe('DATES_BLOCKED');
    expect(blockProblem(dayOf('2026-10-15'), dayOf('2026-10-20'), [row()], today)).toBeNull();
    // A block that ends today is still ahead of us.
    expect(blockProblem(dayOf('2026-09-20'), dayOf('2026-09-25'), [], today)).toBeNull();
  });
});

describe('addBlockedDate', () => {
  it('writes the days, audits the block, and answers it as calendar days', async () => {
    const block = await addBlockedDate('lst_1', { from: '2026-10-12', to: '2026-10-14', reason: '  Repainting ' }, actor);
    expect(listings.assertCanEditListing).toHaveBeenCalledWith('lst_1', actor);
    expect(slots.slotsHeldFor).toHaveBeenCalledWith(['lst_1'], { from: new Date('2026-10-12T00:00:00Z'), to: new Date('2026-10-14T23:59:59.999Z') });
    expect(repository.createBlockedDate).toHaveBeenCalledWith({ listingId: 'lst_1', from: new Date('2026-10-12T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z'), reason: 'Repainting', createdById: 'usr_pub' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'LISTING_DATES_BLOCKED', expect.objectContaining({ targetId: 'lst_1', metadata: expect.objectContaining({ from: '2026-10-12', to: '2026-10-14' }) }));
    expect(block).toMatchObject({ id: 'blk_1', from: '2026-10-12', to: '2026-10-14', reason: 'Repainting' });
  });

  it('refuses days an advertiser holds — a booking or a live reservation on the spot', async () => {
    slots.slotsHeldFor.mockResolvedValue(new Map([['lst_1', 1]]));
    await expect(addBlockedDate('lst_1', { from: '2026-10-12', to: '2026-10-14' }, actor)).rejects.toMatchObject({ statusCode: 409, code: 'DATES_BOOKED' });
    expect(repository.createBlockedDate).not.toHaveBeenCalled();
  });

  it('refuses an overlap with a block already there, and a reversed range, before touching the count', async () => {
    repository.findBlockedDates.mockResolvedValue([row()]);
    await expect(addBlockedDate('lst_1', { from: '2026-10-13', to: '2026-10-20' }, actor)).rejects.toMatchObject({ statusCode: 409, code: 'DATES_BLOCKED' });
    await expect(addBlockedDate('lst_1', { from: '2026-12-20', to: '2026-12-01' }, actor)).rejects.toMatchObject({ statusCode: 400, code: 'DATES_REVERSED' });
    expect(slots.slotsHeldFor).not.toHaveBeenCalled();
  });

  it('is fenced by ownership: somebody else\'s listing is the 403 the edit rule throws', async () => {
    listings.assertCanEditListing.mockRejectedValue(Object.assign(new Error('not yours'), { statusCode: 403 }));
    await expect(addBlockedDate('lst_1', { from: '2026-10-12', to: '2026-10-14' }, actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(listBlockedDates('lst_1', actor)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('removeBlockedDate', () => {
  it('removes a block of this listing and audits it', async () => {
    repository.findBlockedDate.mockResolvedValue(row());
    await expect(removeBlockedDate('lst_1', 'blk_1', actor)).resolves.toMatchObject({ id: 'blk_1', from: '2026-10-12' });
    expect(repository.deleteBlockedDate).toHaveBeenCalledWith('blk_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'LISTING_DATES_UNBLOCKED', expect.objectContaining({ targetId: 'lst_1' }));
  });

  it('a block on another listing is not found here', async () => {
    repository.findBlockedDate.mockResolvedValue(row({ listingId: 'lst_2' }));
    await expect(removeBlockedDate('lst_1', 'blk_1', actor)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.deleteBlockedDate).not.toHaveBeenCalled();
  });
});
