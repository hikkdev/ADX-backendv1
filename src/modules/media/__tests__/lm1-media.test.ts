import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LM-1 — the media library.
 *
 * Pinned: the five specs and their floors; a picture is held to its spec's
 * shape within 1%, its minimum size and its byte cap, and refused before
 * anything is stored (the temp file removed); a stored picture is recorded
 * with its real pixel size (EXIF quarter turns swapped); tags arrive three
 * ways and leave as one; a picture a published layout draws cannot be
 * archived (409 naming the surfaces); every write is audited.
 */

const { repository, audit, uploads } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setArchived: vi.fn(),
    publishedUsage: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
  uploads: { storeUpload: vi.fn() },
}));

vi.mock('../prisma-media.repository', () => ({ prismaMediaRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));
vi.mock('../../uploads', () => ({ storeUpload: uploads.storeUpload }));

import { archiveMedia, patchMedia, readImageSize, restoreMedia, storeMediaFile } from '../media.service';
import { MEDIA_SPECS, checkAgainstSpec, mediaIdsIn, ratioMatches, specFor } from '../media.types';
import { listMediaQuerySchema, parseTags, uploadMediaFieldsSchema } from '../media.schema';

const asset = (over: Record<string, unknown> = {}) => ({
  id: 'med_1',
  fileId: 'file_1',
  url: 'http://x/uploads/a.jpg',
  mime: 'image/jpeg',
  width: 1600,
  height: 480,
  bytes: 1000,
  altText: 'A red banner',
  title: 'Banner',
  tags: [],
  spec: 'PROMO_WIDE',
  ownerAdvertiserId: null,
  createdByUserId: 'usr_admin',
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

async function tempImage(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
  const file = path.join(os.tmpdir(), `lm1-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`);
  await sharp({ create: { width, height, channels: 3, background: '#E40209' } })[format]().toFile(file);
  return { path: file, filename: path.basename(file), originalname: `artwork.${format}`, mimetype: `image/${format}`, size: fs.statSync(file).size };
}

const actor = { userId: 'usr_admin', isAdmin: true, baseUrl: 'http://localhost:3000' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.create.mockImplementation(async (data: Record<string, unknown>) => asset({ id: 'med_new', ...data }));
  uploads.storeUpload.mockImplementation(async (_user: string, file: { path: string }) => {
    fs.rmSync(file.path, { force: true });
    return { id: 'file_new', url: 'http://localhost:3000/uploads/new.jpg' };
  });
});

describe('the specs', () => {
  it('are the five the contract names, at the sizes it names, with a 75% floor', () => {
    expect(MEDIA_SPECS.map((s) => [s.key, s.width, s.height])).toEqual([
      ['PROMO_WIDE', 1600, 480],
      ['PROMO_SQUARE', 1080, 1080],
      ['TILE', 600, 600],
      ['AD_SIDEBAR', 600, 750],
      ['AD_BANNER', 1456, 180],
    ]);
    for (const spec of MEDIA_SPECS) {
      expect(spec.minWidth).toBe(Math.round(spec.width * 0.75));
      expect(spec.formats).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    }
  });

  it('holds the shape within 1%', () => {
    const wide = specFor('PROMO_WIDE')!;
    expect(ratioMatches(1600, 480, wide)).toBe(true);
    expect(ratioMatches(1600, 484, wide)).toBe(true);
    expect(ratioMatches(1600, 500, wide)).toBe(false);
    expect(ratioMatches(0, 480, wide)).toBe(false);
  });

  it('names every way a picture misses', () => {
    const verdict = checkAgainstSpec({ width: 400, height: 400, bytes: 3 * 1024 * 1024, mime: 'image/gif' }, specFor('PROMO_WIDE')!);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems).toHaveLength(4);
    expect(checkAgainstSpec({ width: 1200, height: 360, bytes: 1000, mime: 'image/png' }, specFor('PROMO_WIDE')!)).toEqual({ ok: true });
  });
});

describe('the words around a picture', () => {
  it('reads tags three ways', () => {
    expect(parseTags('Launch, pune ,launch')).toEqual(['launch', 'pune']);
    expect(parseTags('["A","b"]')).toEqual(['a', 'b']);
    expect(parseTags(['X', ' y '])).toEqual(['x', 'y']);
    expect(parseTags(undefined)).toBeUndefined();
  });

  it('normalises the upload fields and the list query', () => {
    expect(uploadMediaFieldsSchema.parse({ spec: 'tile', altText: '  ', tags: 'a,b' })).toEqual({ spec: 'TILE', tags: ['a', 'b'] });
    expect(listMediaQuerySchema.parse({ spec: 'TILE,promo_wide', archived: 'true' })).toMatchObject({ spec: ['TILE', 'PROMO_WIDE'], archived: true, limit: 200 });
    expect(listMediaQuerySchema.safeParse({ spec: 'HUGE' }).success).toBe(false);
  });

  it('finds every mediaId in a block, at any depth', () => {
    expect([...mediaIdsIn({ mediaId: 'a', tiles: [{ mediaId: 'b' }, { mediaId: 'c', x: { mediaId: 'd' } }] })].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('uploading', () => {
  it('reads the real pixel size', async () => {
    const file = await tempImage(600, 750);
    expect(await readImageSize(file.path)).toMatchObject({ width: 600, height: 750 });
    fs.rmSync(file.path, { force: true });
  });

  it('stores a picture that meets its spec, with its size, spec and alt text, and audits it', async () => {
    const file = await tempImage(1600, 480);
    const view = await storeMediaFile(file, { spec: 'PROMO_WIDE', altText: ' Red banner ', tags: ['launch'] }, actor);
    expect(uploads.storeUpload).toHaveBeenCalledWith('usr_admin', file, 'MEDIA', 'http://localhost:3000', { isAdmin: true });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file_new', width: 1600, height: 480, spec: 'PROMO_WIDE', altText: 'Red banner', tags: ['launch'], title: 'artwork', ownerAdvertiserId: null }),
    );
    expect(view.archived).toBe(false);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'MEDIA_UPLOADED', expect.objectContaining({ targetId: 'med_new' }));
  });

  it('refuses a picture off its spec before storing anything, and removes the temp file', async () => {
    const file = await tempImage(800, 800);
    await expect(storeMediaFile(file, { spec: 'PROMO_WIDE' }, actor)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_IMAGE' });
    expect(uploads.storeUpload).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('refuses a type the library does not take', async () => {
    const file = { ...(await tempImage(600, 600)), mimetype: 'application/pdf' };
    await expect(storeMediaFile(file, {}, actor)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('takes a picture with no spec as it is', async () => {
    const file = await tempImage(333, 222, 'png');
    await storeMediaFile(file, {}, actor);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ spec: null, width: 333, height: 222, mime: 'image/png' }));
  });
});

describe('archiving', () => {
  it('refuses a picture a published layout draws, naming where', async () => {
    repository.findById.mockResolvedValue(asset());
    repository.publishedUsage.mockResolvedValue([{ surface: 'APP_ADVERTISER_HOME', number: 3, blockId: 'b1', blockType: 'promo_banner' }]);
    await expect(archiveMedia('med_1', { userId: 'usr_admin' })).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'MEDIA_IN_USE', surfaces: ['APP_ADVERTISER_HOME'] },
    });
    expect(repository.setArchived).not.toHaveBeenCalled();
  });

  it('archives and restores one nothing live draws, and audits both', async () => {
    repository.findById.mockResolvedValue(asset());
    repository.publishedUsage.mockResolvedValue([]);
    repository.setArchived.mockImplementation(async (_id: string, at: Date | null) => asset({ archivedAt: at }));
    expect((await archiveMedia('med_1', { userId: 'usr_admin' })).archived).toBe(true);
    repository.findById.mockResolvedValue(asset({ archivedAt: new Date() }));
    expect((await restoreMedia('med_1', { userId: 'usr_admin' })).archived).toBe(false);
    expect(audit.logActivity.mock.calls.map((call) => call[1])).toEqual(['MEDIA_ARCHIVED', 'MEDIA_RESTORED']);
  });

  it('404s an unknown picture', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(patchMedia('nope', { altText: 'x' }, { userId: 'u' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
