import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ad artwork leaves the library (28 Sep 2026). The owner, looking at
 * Content › Media library full of "Ad artwork" cards: "if this is about ads,
 * shouldn't it be present inside ads and promotions?"
 *
 * Pinned: `GET /media` takes `owner=adx|advertisers|all`, `all` by default
 * so a caller that does not ask sees what it always saw; an advertiser's
 * artwork cannot be archived while a booking that shows it is still open
 * (409 AD_ARTWORK_IN_USE naming the booking), and may be once every such
 * booking has ended, been rejected or cancelled; ADX's own pictures never
 * read the bookings at all.
 */

const { repository, audit } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setArchived: vi.fn(),
    publishedUsage: vi.fn(),
    openAdBookings: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
}));

vi.mock('../prisma-media.repository', () => ({ prismaMediaRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));
vi.mock('../../uploads', () => ({ storeUpload: vi.fn(), baseUrlFor: vi.fn() }));

import { listHandler } from '../media.controller';
import { listMediaQuerySchema } from '../media.schema';
import { archiveMedia, listMedia } from '../media.service';

const asset = (over: Record<string, unknown> = {}) => ({
  id: 'med_ad',
  fileId: 'file_1',
  url: 'http://x/uploads/ad.jpg',
  mime: 'image/jpeg',
  width: 600,
  height: 750,
  bytes: 1000,
  altText: 'Diwali sale',
  title: 'Diwali sale',
  tags: ['ad', 'web_listing_sidebar'],
  spec: 'AD_SIDEBAR',
  ownerAdvertiserId: 'adv_1',
  createdByUserId: 'usr_buyer',
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const actor = { userId: 'usr_admin' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.list.mockResolvedValue([]);
  repository.publishedUsage.mockResolvedValue([]);
  repository.openAdBookings.mockResolvedValue([]);
  repository.setArchived.mockImplementation(async (id: string, at: Date | null) => asset({ id, archivedAt: at }));
});

describe('the owner filter on GET /media', () => {
  it('reads adx, advertisers and all — any case — and defaults to all', () => {
    expect(listMediaQuerySchema.parse({}).owner).toBe('all');
    expect(listMediaQuerySchema.parse({ owner: 'adx' }).owner).toBe('adx');
    expect(listMediaQuerySchema.parse({ owner: ' Advertisers ' }).owner).toBe('advertisers');
    expect(listMediaQuerySchema.parse({ owner: 'all' }).owner).toBe('all');
  });

  it('refuses an owner it does not know', () => {
    expect(listMediaQuerySchema.safeParse({ owner: 'publishers' }).success).toBe(false);
    expect(listMediaQuerySchema.safeParse({ owner: '' }).success).toBe(false);
  });

  it('hands the owner to the repository, beside the other filters', async () => {
    await listMedia({ q: 'sale', archived: false, owner: 'advertisers', limit: 50 });
    expect(repository.list).toHaveBeenCalledWith({ q: 'sale', archived: false, owner: 'advertisers', limit: 50 });
  });

  it('the route passes the owner through, and asks for every picture when none is named', async () => {
    const res = { json: vi.fn() } as unknown as Response;
    await listHandler({ query: { owner: 'adx', spec: 'tile' } } as unknown as Request, res);
    expect(repository.list).toHaveBeenLastCalledWith(expect.objectContaining({ owner: 'adx', specs: ['TILE'], archived: false, limit: 200 }));
    await listHandler({ query: {} } as unknown as Request, res);
    expect(repository.list).toHaveBeenLastCalledWith(expect.objectContaining({ owner: 'all' }));
  });

  it('the route 400s an unknown owner', async () => {
    const res = { json: vi.fn() } as unknown as Response;
    await expect(listHandler({ query: { owner: 'someone' } } as unknown as Request, res)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(repository.list).not.toHaveBeenCalled();
  });
});

describe("archiving an advertiser's ad artwork", () => {
  it('is refused while a booking that shows it is still open, naming the booking', async () => {
    repository.findById.mockResolvedValue(asset());
    repository.openAdBookings.mockResolvedValue([{ id: 'adb_1', displayId: 'ADB-2809-2601', status: 'LIVE' }]);
    const refusal = archiveMedia('med_ad', actor);
    await expect(refusal).rejects.toMatchObject({
      statusCode: 409,
      code: 'AD_ARTWORK_IN_USE',
      message:
        "This is an advertiser's ad artwork on booking ADB-2809-2601, which is still open — it can be archived once the booking ends, is rejected or cancelled.",
      details: { reason: 'AD_ARTWORK_IN_USE', ownerAdvertiserId: 'adv_1', bookings: [{ id: 'adb_1', displayId: 'ADB-2809-2601', status: 'LIVE' }] },
    });
    expect(repository.openAdBookings).toHaveBeenCalledWith('med_ad');
    expect(repository.setArchived).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('names the booking by its id when it has no display id yet (a draft)', async () => {
    repository.findById.mockResolvedValue(asset());
    repository.openAdBookings.mockResolvedValue([{ id: 'adb_draft', displayId: null, status: 'DRAFT' }]);
    await expect(archiveMedia('med_ad', actor)).rejects.toMatchObject({ code: 'AD_ARTWORK_IN_USE', message: expect.stringContaining('on booking adb_draft,') });
  });

  it('goes once every booking that showed it has ended, been rejected or cancelled', async () => {
    repository.findById.mockResolvedValue(asset());
    repository.openAdBookings.mockResolvedValue([]);
    const archived = await archiveMedia('med_ad', actor);
    expect(archived.archived).toBe(true);
    expect(repository.setArchived).toHaveBeenCalledWith('med_ad', expect.any(Date));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'MEDIA_ARCHIVED', expect.objectContaining({ targetId: 'med_ad' }));
  });

  it("is still held by a published layout that draws it, after the bookings' check", async () => {
    repository.findById.mockResolvedValue(asset());
    repository.publishedUsage.mockResolvedValue([{ surface: 'WEB_HOME', number: 2, blockId: 'b1', blockType: 'promo_banner' }]);
    await expect(archiveMedia('med_ad', actor)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'MEDIA_IN_USE' } });
    expect(repository.setArchived).not.toHaveBeenCalled();
  });

  it('an already-archived picture answers as it is, without reading the bookings', async () => {
    repository.findById.mockResolvedValue(asset({ archivedAt: new Date() }));
    expect((await archiveMedia('med_ad', actor)).archived).toBe(true);
    expect(repository.openAdBookings).not.toHaveBeenCalled();
  });
});

describe("ADX's own pictures", () => {
  it('never read the bookings — only the published layouts hold them', async () => {
    repository.findById.mockResolvedValue(asset({ id: 'med_tile', ownerAdvertiserId: null, tags: [] }));
    expect((await archiveMedia('med_tile', actor)).archived).toBe(true);
    expect(repository.openAdBookings).not.toHaveBeenCalled();
    expect(repository.publishedUsage).toHaveBeenCalledWith('med_tile');
  });
});
