import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-24 (the owner, 17 Sep 2026) — the right to sell a space, and its term.
 *
 * A hoarding, a digital billboard, a shelter: many spots are held on a
 * lease, a licence or a permit a civic body renews every year. Pinned: the
 * listing says how it is held and until when (OWNED needs no date; the
 * rest do); a publisher may only set their own; a term already past lapses
 * the spot at once; the sweep reminds thirty and seven days out — once per
 * window — and on the day marks the spot lapsed, off the shelf, telling the
 * publisher and ADX; an approved permit or agreement with a later end date
 * renews the term and lifts the lapse; a document carries the day it runs
 * out as the last instant of that day in India.
 */

const { repository, notifications, users } = vi.hoisted(() => ({
  repository: {
    findListing: vi.fn(),
    setRights: vi.fn(),
    rightsDue: vi.fn(),
    publisherUserId: vi.fn(),
    publisherIdOfUser: vi.fn(),
    addDocument: vi.fn(),
    findDocument: vi.fn(),
    reviewDocument: vi.fn(),
    documentsCleared: vi.fn(),
    markDocumentsCleared: vi.fn(),
    setListingStatus: vi.fn(),
  },
  notifications: { createNotification: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
}));

vi.mock('../prisma-supply.repository', () => ({ prismaSupplyRepository: repository }));
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);

import { reviewDocument, rightsState, runRightsSweep, setRights, submitDocument } from '../supply.service';
import { rightsSchema, submitDocumentSchema } from '../supply.schema';

const NOW = new Date('2026-09-20T06:00:00.000Z');
const DAY = 86_400_000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'Hebbal Flyover Approach — Airport Road Billboard',
  publisherId: 'pub_1',
  status: 'ACTIVE',
  availableNow: true,
  rightsBasis: 'PERMIT',
  rightsValidUntil: inDays(200),
  rightsLapsedAt: null,
  rightsRemindedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.setRights.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...listing(), ...data }));
  repository.publisherUserId.mockResolvedValue('usr_pub');
  repository.publisherIdOfUser.mockResolvedValue('pub_1');
  notifications.createNotification.mockResolvedValue({});
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
});

describe('the schema', () => {
  it('needs a date unless the space is owned, and only a calendar day', () => {
    expect(rightsSchema.safeParse({ basis: 'OWNED' }).success).toBe(true);
    expect(rightsSchema.safeParse({ basis: 'LEASED' }).success).toBe(false);
    expect(rightsSchema.safeParse({ basis: 'LEASED', validUntil: '2027-03-31' }).success).toBe(true);
    expect(rightsSchema.safeParse({ basis: 'PERMIT', validUntil: '31/03/2027' }).success).toBe(false);
    expect(submitDocumentSchema.safeParse({ kind: 'MUNICIPAL_PERMIT', url: 'https://cdn.adx.in/p.jpg', expiresAt: '2027-03-31' }).success).toBe(true);
  });
});

describe('the state of a right', () => {
  it('reads owned, current, ending inside the first reminder window, and lapsed past the day or once stamped', () => {
    expect(rightsState(listing({ rightsBasis: 'OWNED', rightsValidUntil: null }) as never, NOW)).toBe('OWNED');
    expect(rightsState(listing({ rightsValidUntil: inDays(60) }) as never, NOW)).toBe('CURRENT');
    expect(rightsState(listing({ rightsValidUntil: inDays(10) }) as never, NOW)).toBe('ENDING');
    expect(rightsState(listing({ rightsValidUntil: inDays(-1) }) as never, NOW)).toBe('LAPSED');
    expect(rightsState(listing({ rightsValidUntil: inDays(90), rightsLapsedAt: inDays(-3) }) as never, NOW)).toBe('LAPSED');
  });
});

describe('setting how a space is held', () => {
  it("a publisher sets their own spot's lease with the day it runs out, stored as the last instant of that day in India", async () => {
    repository.findListing.mockResolvedValue(listing({ rightsBasis: 'OWNED', rightsValidUntil: null }));
    await setRights('lst_1', { basis: 'LEASED', validUntil: '2027-03-31' }, { userId: 'usr_pub', roles: ['PUBLISHER'] }, NOW);
    expect(repository.setRights).toHaveBeenCalledWith('lst_1', {
      rightsBasis: 'LEASED',
      rightsValidUntil: new Date('2027-03-31T18:29:59.999Z'),
      rightsLapsedAt: null,
      rightsRemindedAt: null,
    });
  });

  it('a term already past lapses the spot at once and takes it off the shelf', async () => {
    repository.findListing.mockResolvedValue(listing());
    await setRights('lst_1', { basis: 'PERMIT', validUntil: '2026-09-01' }, { userId: 'usr_admin', roles: ['ADMIN'] }, NOW);
    expect(repository.setRights).toHaveBeenCalledWith('lst_1', expect.objectContaining({ rightsLapsedAt: NOW, availableNow: false }));
  });

  it('owned clears the term and any lapse', async () => {
    repository.findListing.mockResolvedValue(listing({ rightsLapsedAt: inDays(-2) }));
    await setRights('lst_1', { basis: 'OWNED' }, { userId: 'usr_pub', roles: ['PUBLISHER'] }, NOW);
    expect(repository.setRights).toHaveBeenCalledWith('lst_1', { rightsBasis: 'OWNED', rightsValidUntil: null, rightsLapsedAt: null, rightsRemindedAt: null });
  });

  it("refuses a publisher on somebody else's spot, and a lease with no date", async () => {
    repository.findListing.mockResolvedValue(listing({ publisherId: 'pub_2' }));
    await expect(setRights('lst_1', { basis: 'LEASED', validUntil: '2027-01-01' }, { userId: 'usr_pub', roles: ['PUBLISHER'] }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    repository.findListing.mockResolvedValue(listing());
    await expect(setRights('lst_1', { basis: 'LEASED', validUntil: null }, { userId: 'usr_pub', roles: ['PUBLISHER'] }, NOW)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('the sweep', () => {
  it('reminds once per window, lapses a term past its day, and tells the publisher and ADX', async () => {
    repository.rightsDue.mockResolvedValue([
      // 20 days out, never reminded: the thirty-day window.
      listing({ id: 'a', rightsValidUntil: inDays(20) }),
      // 5 days out, reminded 25 days ago (the thirty-day window): the seven-day one is new.
      listing({ id: 'b', rightsValidUntil: inDays(5), rightsRemindedAt: inDays(-25) }),
      // 5 days out, reminded yesterday: nothing more to say.
      listing({ id: 'c', rightsValidUntil: inDays(5), rightsRemindedAt: inDays(-1) }),
      // Past its day, not yet stamped: lapses.
      listing({ id: 'd', rightsValidUntil: inDays(-1), publisherName: 'Skyline Outdoor Media' }),
      // Past its day, already lapsed: left alone.
      listing({ id: 'e', rightsValidUntil: inDays(-10), rightsLapsedAt: inDays(-9) }),
    ]);
    const result = await runRightsSweep(NOW);
    expect(result).toEqual({ considered: 5, lapsed: 1, reminded: 2 });
    expect(repository.setRights).toHaveBeenCalledWith('a', { rightsRemindedAt: NOW });
    expect(repository.setRights).toHaveBeenCalledWith('b', { rightsRemindedAt: NOW });
    expect(repository.setRights).not.toHaveBeenCalledWith('c', expect.anything());
    expect(repository.setRights).toHaveBeenCalledWith('d', { rightsLapsedAt: NOW, availableNow: false });
    expect(repository.setRights).not.toHaveBeenCalledWith('e', expect.anything());
    const sent = notifications.createNotification.mock.calls.map((call) => call[0] as { userId: string; title: string; relatedId: string });
    expect(sent.filter((note) => note.userId === 'usr_pub' && note.relatedId === 'a')).toHaveLength(1);
    expect(sent.find((note) => note.relatedId === 'a')?.title).toContain('ends in 20 days');
    expect(sent.filter((note) => note.relatedId === 'd').map((note) => note.userId).sort()).toEqual(['usr_admin', 'usr_pub']);
    expect(sent.find((note) => note.relatedId === 'd' && note.userId === 'usr_pub')?.title).toBe('Your right to this spot has run out');
  });
});

describe('a renewal at the desk', () => {
  it('an approved permit with a later end date extends the term, lifts the lapse and puts the spot back', async () => {
    repository.findDocument.mockResolvedValue({ id: 'doc_1', listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', expiresAt: new Date('2027-09-30T23:59:59.999Z') });
    repository.reviewDocument.mockResolvedValue({ id: 'doc_1', listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', status: 'VERIFIED', expiresAt: new Date('2027-09-30T23:59:59.999Z') });
    repository.documentsCleared.mockResolvedValue(true);
    repository.markDocumentsCleared.mockResolvedValue({});
    repository.findListing.mockResolvedValue(listing({ rightsValidUntil: inDays(-2), rightsLapsedAt: inDays(-2), availableNow: false }));
    await reviewDocument({ documentId: 'doc_1', approve: true, reviewedByUserId: 'usr_admin' });
    expect(repository.setRights).toHaveBeenCalledWith('lst_1', { rightsValidUntil: new Date('2027-09-30T23:59:59.999Z'), rightsLapsedAt: null, rightsRemindedAt: null, availableNow: true });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_pub', title: 'Renewal approved' }));
  });

  it('changes nothing for an owned space, an earlier date, a rejection, or a paper with no end date', async () => {
    repository.reviewDocument.mockResolvedValue({ id: 'doc_1', listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', status: 'VERIFIED', expiresAt: inDays(100) });
    repository.documentsCleared.mockResolvedValue(true);
    repository.markDocumentsCleared.mockResolvedValue({});
    repository.findDocument.mockResolvedValue({ id: 'doc_1', listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', expiresAt: inDays(100) });

    repository.findListing.mockResolvedValue(listing({ rightsBasis: 'OWNED', rightsValidUntil: null }));
    await reviewDocument({ documentId: 'doc_1', approve: true, reviewedByUserId: 'usr_admin' });
    repository.findListing.mockResolvedValue(listing({ rightsValidUntil: inDays(200) }));
    await reviewDocument({ documentId: 'doc_1', approve: true, reviewedByUserId: 'usr_admin' });
    await reviewDocument({ documentId: 'doc_1', approve: false, rejectionReason: 'Blurred', reviewedByUserId: 'usr_admin' });
    repository.reviewDocument.mockResolvedValue({ id: 'doc_1', listingId: 'lst_1', kind: 'ADDRESS_PROOF', status: 'VERIFIED', expiresAt: null });
    await reviewDocument({ documentId: 'doc_1', approve: true, reviewedByUserId: 'usr_admin' });
    expect(repository.setRights).not.toHaveBeenCalled();
  });

  it('a document carries the day it runs out as the last instant of that day in India', async () => {
    repository.findListing.mockResolvedValue(listing());
    repository.addDocument.mockResolvedValue({ id: 'doc_2' });
    await submitDocument({ listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', url: 'https://cdn.adx.in/permit.jpg', expiresAt: '2027-03-31' });
    expect(repository.addDocument).toHaveBeenCalledWith({ listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', url: 'https://cdn.adx.in/permit.jpg', expiresAt: new Date('2027-03-31T18:29:59.999Z') });
  });
});
