import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CT-1 — the pages ADX writes itself.
 *
 * Pinned: a slug is an address and is held to a shape, with the desk's own
 * prefix reserved; a new version takes the next number for its slug;
 * publishing retires whatever was live and an older version republished is
 * a rollback; only a draft may be edited or discarded; a page with no
 * surface cannot be published; a page may be taken down and then 404s; the
 * index carries no bodies and the SEO fields fall back to the title and
 * the summary.
 */

const { repository, audit } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    findById: vi.fn(),
    active: vi.fn(),
    activeAll: vi.fn(),
    highestVersion: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
  },
  audit: { logActivity: vi.fn(async () => undefined) },
}));

vi.mock('../prisma-content.repository', () => ({ prismaContentRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));

import {
  createPage,
  currentPage,
  deletePage,
  pageState,
  publicIndex,
  publishPage,
  unpublishPage,
  updatePage,
} from '../content.service';
import { RESERVED_SLUGS, SLUG_PATTERN, pageLive, slugify } from '../content.types';

const page = (over: Record<string, unknown> = {}) => ({
  id: 'cnt_1',
  slug: 'how-it-works',
  version: 1,
  category: 'PAGE',
  title: 'How it works',
  summary: 'Three steps from a wall to a booking',
  body: '# How it works\n\nFind a spot, book it, we print and install.',
  surfaces: ['WEBSITE'],
  tags: ['getting-started'],
  seoTitle: null,
  seoDescription: null,
  sortOrder: 0,
  isActive: false,
  publishedAt: null,
  retiredAt: null,
  createdByUserId: 'usr_admin',
  changeNote: null,
  createdAt: new Date('2026-09-24T09:00:00Z'),
  updatedAt: new Date('2026-09-24T09:00:00Z'),
  ...over,
});

const actor = { userId: 'usr_admin' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.highestVersion.mockResolvedValue(0);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => page(data));
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => page({ id, ...patch }));
  repository.publish.mockImplementation(async (id: string) => page({ id, isActive: true, publishedAt: new Date('2026-09-24T10:00:00Z') }));
  repository.unpublish.mockImplementation(async (id: string) => page({ id, isActive: false, publishedAt: new Date('2026-09-24T10:00:00Z'), retiredAt: new Date('2026-09-24T11:00:00Z') }));
});

describe('the slug', () => {
  it('is an address: lowercase, hyphenated, and suggested from a title', () => {
    expect(slugify("Anita's How It Works!")).toBe('anitas-how-it-works');
    expect(slugify('  Spaces   and --- dashes  ')).toBe('spaces-and-dashes');
    expect(SLUG_PATTERN.test('how-it-works')).toBe(true);
    expect(SLUG_PATTERN.test('How-It-Works')).toBe(false);
    expect(SLUG_PATTERN.test('two--hyphens')).toBe(false);
    expect(SLUG_PATTERN.test('-leading')).toBe(false);
  });

  it('refuses a shape the router could not address, and the desk’s own prefix', async () => {
    await expect(createPage({ slug: 'Not A Slug', category: 'PAGE', title: 'x', body: 'y' } as never, actor)).rejects.toMatchObject({ statusCode: 400 });
    for (const reserved of RESERVED_SLUGS) {
      await expect(createPage({ slug: reserved, category: 'PAGE', title: 'x', body: 'y' } as never, actor)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('versions', () => {
  it('starts a new slug at one and gives an existing slug the next number', async () => {
    await createPage({ slug: 'how-it-works', category: 'PAGE', title: 'How it works', body: 'x', surfaces: ['WEBSITE'] } as never, actor);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'how-it-works', version: 1, createdByUserId: 'usr_admin' }));

    repository.highestVersion.mockResolvedValue(4);
    await createPage({ slug: 'how-it-works', category: 'PAGE', title: 'How it works', body: 'x', surfaces: ['WEBSITE'] } as never, actor);
    expect(repository.create).toHaveBeenLastCalledWith(expect.objectContaining({ version: 5 }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CONTENT_PAGE_DRAFTED', expect.anything());
  });

  it('reads a version’s state from its own stamps, and whether the page is live from the set', () => {
    expect(pageState(page())).toBe('DRAFT');
    expect(pageState(page({ isActive: true, publishedAt: new Date() }))).toBe('PUBLISHED');
    // Replaced or taken down, the row itself only knows it was live once.
    expect(pageState(page({ publishedAt: new Date(), retiredAt: new Date() }))).toBe('RETIRED');
    expect(pageState(page({ publishedAt: new Date() }))).toBe('RETIRED');
    // Whether the PAGE is live is a fact about its versions together.
    expect(pageLive([page(), page({ publishedAt: new Date(), retiredAt: new Date() })])).toBe(false);
    expect(pageLive([page({ isActive: true }), page()])).toBe(true);
  });

  it('publishes one version and retires whichever was live — which is how a rollback works', async () => {
    repository.findById.mockResolvedValue(page({ id: 'cnt_3', version: 3 }));
    const published = await publishPage('cnt_3', actor);
    expect(repository.publish).toHaveBeenCalledWith('cnt_3', 'how-it-works', expect.any(Date));
    expect(published.state).toBe('PUBLISHED');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CONTENT_PAGE_PUBLISHED', expect.anything());

    // Publishing version 1 again is the rollback; the service does not care which number it is.
    repository.findById.mockResolvedValue(page({ id: 'cnt_1', version: 1 }));
    await publishPage('cnt_1', actor);
    expect(repository.publish).toHaveBeenLastCalledWith('cnt_1', 'how-it-works', expect.any(Date));
  });

  it('refuses to publish a page that names no surface', async () => {
    repository.findById.mockResolvedValue(page({ surfaces: [] }));
    await expect(publishPage('cnt_1', actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.publish).not.toHaveBeenCalled();
  });
});

describe('what may still change', () => {
  it('lets a draft be edited and discarded', async () => {
    repository.findById.mockResolvedValue(page());
    await updatePage('cnt_1', { title: 'How ADX works' }, actor);
    expect(repository.update).toHaveBeenCalledWith('cnt_1', { title: 'How ADX works' });
    await deletePage('cnt_1', actor);
    expect(repository.delete).toHaveBeenCalledWith('cnt_1');
  });

  it('refuses to edit or discard a version somebody has read', async () => {
    repository.findById.mockResolvedValue(page({ isActive: true, publishedAt: new Date() }));
    await expect(updatePage('cnt_1', { body: 'rewritten' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    await expect(deletePage('cnt_1', actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.findById.mockResolvedValue(page({ publishedAt: new Date(), retiredAt: new Date() }));
    await expect(updatePage('cnt_1', { body: 'rewritten' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('takes a live page down, and refuses to take down one that is not live', async () => {
    repository.findById.mockResolvedValue(page({ isActive: true, publishedAt: new Date() }));
    const down = await unpublishPage('cnt_1', actor);
    expect(down.state).toBe('RETIRED');
    expect(down.isActive).toBe(false);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CONTENT_PAGE_TAKEN_DOWN', expect.anything());
    repository.findById.mockResolvedValue(page());
    await expect(unpublishPage('cnt_1', actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('what a reader gets', () => {
  it('answers one published page, and 404s for a slug with nothing live', async () => {
    repository.active.mockResolvedValue(page({ isActive: true, publishedAt: new Date('2026-09-24T10:00:00Z') }));
    const live = await currentPage('how-it-works');
    expect(live).toMatchObject({ slug: 'how-it-works', title: 'How it works', categoryLabel: 'Page', version: 1 });
    expect(live.body).toContain('Find a spot');
    // The SEO fields fall back rather than being empty in a browser tab.
    expect(live.seoTitle).toBe('How it works');
    expect(live.seoDescription).toBe('Three steps from a wall to a booking');

    repository.active.mockResolvedValue(null);
    await expect(currentPage('gone')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('indexes a surface without bodies', async () => {
    repository.activeAll.mockResolvedValue([page({ isActive: true }), page({ id: 'cnt_2', slug: 'for-publishers', title: 'For publishers', isActive: true })]);
    const index = await publicIndex({ surface: 'WEBSITE' });
    expect(repository.activeAll).toHaveBeenCalledWith({ surface: 'WEBSITE' });
    expect(index).toHaveLength(2);
    expect(index[0]).not.toHaveProperty('body');
    expect(index.map((entry) => entry.slug)).toEqual(['how-it-works', 'for-publishers']);
  });
});
