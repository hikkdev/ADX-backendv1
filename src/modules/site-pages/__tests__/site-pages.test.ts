import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PB-1 — the pages desk and the public reads.
 *
 * Pinned: a custom page is created with its address and a version-1 draft
 * from its template, refused on a taken key, a bad address or a taken one;
 * a content page becomes a Studio page published at once; the title and
 * channels change plainly, the address only where the rules allow (the home
 * never, a system page with its parameter) and every change leaves a
 * permanent redirect and re-points the others; only a custom page archives;
 * a redirect is checked at both ends; the routing table lists live pages
 * and every redirect, the sitemap only indexable website pages; a page
 * resolves like a surface, the draft with a preview token; every write is
 * audited; the public answers are cached and forgotten on a write.
 */

const { repository, audit, layouts, content } = vi.hoisted(() => ({
  repository: {
    listPages: vi.fn(),
    findByKey: vi.fn(),
    pageAtPath: vi.fn(),
    createPage: vi.fn(),
    updatePage: vi.fn(),
    currentVersions: vi.fn(),
    listRedirects: vi.fn(),
    findRedirect: vi.fn(),
    redirectFrom: vi.fn(),
    createRedirect: vi.fn(),
    deleteRedirect: vi.fn(),
    changeAddress: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
  layouts: {
    saveDraft: vi.fn(),
    publishDraft: vi.fn(),
    discardDraft: vi.fn(),
    restoreVersion: vi.fn(),
    listVersions: vi.fn(),
    getVersions: vi.fn(),
    blocksForPreview: vi.fn(),
    draftOrLive: vi.fn(),
    resolveBlocks: vi.fn(),
  },
  content: { currentContentPage: vi.fn() },
}));

vi.mock('../prisma-site-pages.repository', () => ({ prismaSitePagesRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));
vi.mock('../../layouts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../layouts')>()), ...layouts }));
vi.mock('../../content', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../content')>()), currentContentPage: content.currentContentPage }));

import { clearLayoutCache, signPreviewToken } from '../../layouts';
import type { PageRow } from '../site-pages.repository';
import {
  archivePage,
  createFromContent,
  createPage,
  createRedirect,
  deleteRedirect,
  getPage,
  listPages,
  resolvePage,
  restorePage,
  routesTable,
  savePageDraft,
  sitemap,
  updatePage,
  versionKeyOf,
} from '../site-pages.service';

const NOW = new Date('2026-09-27T10:00:00Z');
const actor = { userId: 'usr_admin' };

const page = (over: Partial<PageRow> = {}): PageRow => ({
  id: 'sp_diwali',
  key: 'diwali',
  kind: 'CUSTOM',
  title: 'Diwali offers',
  path: '/diwali-offers',
  internalPath: null,
  surface: null,
  channels: ['WEBSITE'],
  addressLocked: false,
  createdByUserId: 'usr_admin',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  redirectCount: 0,
  ...over,
});

const home = page({ id: 'sp_home', key: 'home', kind: 'SYSTEM', title: 'Home', path: '/', internalPath: '/', surface: 'WEB_HOME', addressLocked: true });
const listing = page({ id: 'sp_listing', key: 'listing', kind: 'SYSTEM', title: 'Listing page', path: '/spaces/:id', internalPath: '/spaces/:id', surface: 'WEB_LISTING' });
const explore = page({ id: 'sp_explore', key: 'explore', kind: 'SYSTEM', title: 'Explore', path: '/spaces', internalPath: '/spaces', surface: 'WEB_EXPLORE' });

const version = (over: Record<string, unknown> = {}) => ({ surface: null, pageId: 'sp_diwali', number: 1, status: 'PUBLISHED', meta: null, publishedAt: NOW, updatedAt: NOW, ...over });

const view = (over: Record<string, unknown> = {}) => ({
  id: 'lv_1',
  number: 1,
  status: 'DRAFT',
  blocks: [{ id: 'h', type: 'hero', props: { headline: 'Diwali' } }],
  meta: null,
  changeNote: null,
  createdAt: NOW,
  updatedAt: NOW,
  publishedAt: null,
  retiredAt: null,
  publishedBy: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearLayoutCache();
  repository.listPages.mockResolvedValue([home, listing, explore, page()]);
  repository.currentVersions.mockResolvedValue([]);
  repository.listRedirects.mockResolvedValue([]);
  repository.findByKey.mockImplementation(async (key: string) => [home, listing, explore, page()].find((row) => row.key === key) ?? null);
  repository.pageAtPath.mockResolvedValue(null);
  repository.redirectFrom.mockResolvedValue(null);
  repository.createPage.mockImplementation(async (data: Record<string, unknown>) => page({ ...data, id: 'sp_new', kind: 'CUSTOM' }));
  repository.updatePage.mockImplementation(async (id: string, patch: Record<string, unknown>) => page({ id, ...patch }));
  repository.changeAddress.mockImplementation(async ({ pageId, newPath }: { pageId: string; newPath: string }) => ({ page: page({ id: pageId, path: newPath }), retargeted: 0 }));
  repository.createRedirect.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'rd_1', createdAt: NOW, ...data }));
  layouts.getVersions.mockResolvedValue({ live: null, draft: null });
  layouts.listVersions.mockResolvedValue([]);
  layouts.saveDraft.mockResolvedValue(view());
  layouts.publishDraft.mockResolvedValue(view({ status: 'PUBLISHED', publishedAt: NOW }));
  layouts.resolveBlocks.mockImplementation(async (blocks: unknown[]) => blocks);
});

describe('the list and the detail', () => {
  it("lists the site's own pages first with what is live and what waits, and reads one with its versions and defaults", async () => {
    repository.currentVersions.mockResolvedValue([
      version({ surface: 'WEB_HOME', pageId: null, number: 2 }),
      version({ surface: 'WEB_HOME', pageId: null, number: 3, status: 'DRAFT' }),
      version({ number: 1, status: 'DRAFT' }),
    ]);
    const list = await listPages();
    expect(list.map((row) => row.key)).toEqual(['explore', 'home', 'listing', 'diwali']);
    expect(list[1]).toMatchObject({ key: 'home', live: { number: 2, publishedAt: NOW }, draft: { number: 3, updatedAt: NOW }, addressLocked: true });
    expect(list[3]).toMatchObject({ key: 'diwali', live: null, draft: { number: 1 }, redirectCount: 0 });

    layouts.getVersions.mockResolvedValue({ live: view({ status: 'PUBLISHED' }), draft: null });
    const detail = await getPage('home');
    expect(layouts.getVersions).toHaveBeenCalledWith({ surface: 'WEB_HOME' });
    expect(detail.defaults.map((block) => block.type)).toEqual(['legacy_home']);
    expect(detail.live!.status).toBe('PUBLISHED');
    expect((await getPage('diwali')).defaults).toEqual([]);
    await expect(getPage('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keys versions by the surface for a system page and by the row for a custom one', () => {
    expect(versionKeyOf(home)).toEqual({ surface: 'WEB_HOME' });
    expect(versionKeyOf(page())).toEqual({ pageId: 'sp_diwali' });
    expect(() => versionKeyOf(page({ kind: 'SYSTEM', surface: null }))).toThrow();
  });
});

describe('creating a page', () => {
  it('creates a custom page with its address and a draft from the template, and audits', async () => {
    const detail = await createPage({ key: 'holi', title: 'Holi', path: '/holi', channels: ['WEBSITE', 'APPS'], template: 'event' }, actor);
    expect(repository.createPage).toHaveBeenCalledWith({ key: 'holi', title: 'Holi', path: '/holi', channels: ['WEBSITE', 'APPS'], createdByUserId: 'usr_admin' });
    const [key, input] = layouts.saveDraft.mock.calls[0] as [unknown, { blocks: { type: string }[] }];
    expect(key).toEqual({ pageId: 'sp_new' });
    expect(input.blocks.map((block) => block.type)).toEqual(['hero', 'columns', 'listing_grid', 'faq', 'cta_strip']);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'SITE_PAGE_CREATED', expect.objectContaining({ targetId: 'sp_new', metadata: expect.objectContaining({ template: 'event' }) }));
    expect(detail.key).toBe('holi');
  });

  it('defaults to the website and a blank draft', async () => {
    await createPage({ key: 'holi', title: 'Holi', path: '/holi' }, actor);
    expect(repository.createPage).toHaveBeenCalledWith(expect.objectContaining({ channels: ['WEBSITE'] }));
    expect((layouts.saveDraft.mock.calls[0] as [unknown, { blocks: unknown[] }])[1].blocks).toEqual([]);
  });

  it("refuses a key that is taken or one of the site's own, a bad address, and an address that is taken either way", async () => {
    await expect(createPage({ key: 'home', title: 'x', path: '/x' }, actor)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/site's own/) });
    await expect(createPage({ key: 'diwali', title: 'x', path: '/x' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    await expect(createPage({ key: 'holi', title: 'x', path: '/studio/x' }, actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/reserved/) });
    repository.pageAtPath.mockResolvedValueOnce(explore);
    await expect(createPage({ key: 'holi', title: 'x', path: '/spaces' }, actor)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/address of "Explore"/) });
    repository.redirectFrom.mockResolvedValueOnce({ id: 'rd_9', fromPath: '/old', toPath: '/spaces', pageId: null });
    await expect(createPage({ key: 'holi', title: 'x', path: '/old' }, actor)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already redirects/) });
    expect(repository.createPage).not.toHaveBeenCalled();
  });

  it('PB-6: turns a published website content page into a Studio page, published at once', async () => {
    content.currentContentPage.mockResolvedValue({ slug: 'careers', title: 'Careers', surfaces: ['WEBSITE'], seoTitle: 'Careers at ADX', seoDescription: null });
    const detail = await createFromContent('careers', actor);
    expect(repository.createPage).toHaveBeenCalledWith(expect.objectContaining({ key: 'careers', path: '/careers', title: 'Careers' }));
    expect(layouts.saveDraft).toHaveBeenCalledWith(
      { pageId: 'sp_new' },
      expect.objectContaining({ blocks: [{ id: 'careers-text', type: 'rich_text', props: { contentSlug: 'careers' } }], meta: { seoTitle: 'Careers at ADX' } }),
      actor,
    );
    expect(layouts.publishDraft).toHaveBeenCalledWith({ pageId: 'sp_new' }, {}, actor);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'SITE_PAGE_CREATED', expect.objectContaining({ metadata: expect.objectContaining({ fromContent: 'careers' }) }));
    expect(detail.key).toBe('careers');

    content.currentContentPage.mockResolvedValue({ slug: 'tips', title: 'Tips', surfaces: ['APP_USER'] });
    await expect(createFromContent('tips', actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not a website page/) });
  });
});

describe('changing a page', () => {
  it('changes the title and channels, audited with a diff, and leaves a system page on the website', async () => {
    await updatePage('diwali', { title: 'Diwali 2026', channels: ['APPS', 'WEBSITE'] }, actor);
    expect(repository.updatePage).toHaveBeenCalledWith('sp_diwali', { title: 'Diwali 2026', channels: ['APPS', 'WEBSITE'] });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'SITE_PAGE_UPDATED',
      expect.objectContaining({ diff: { title: { before: 'Diwali offers', after: 'Diwali 2026' }, channels: { before: ['WEBSITE'], after: ['APPS', 'WEBSITE'] } } }),
    );
    await expect(updatePage('explore', { channels: ['APPS'] }, actor)).rejects.toMatchObject({ statusCode: 400 });
    // The same values again are not a change.
    vi.clearAllMocks();
    await updatePage('diwali', { title: 'Diwali offers', channels: ['WEBSITE'] }, actor);
    expect(repository.updatePage).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('moves a page, writing the redirect and re-pointing the others, and audits the old and new address', async () => {
    repository.changeAddress.mockResolvedValueOnce({ page: page({ path: '/festive-offers' }), retargeted: 2 });
    await updatePage('diwali', { path: '/festive-offers' }, actor);
    expect(repository.changeAddress).toHaveBeenCalledWith({ pageId: 'sp_diwali', oldPath: '/diwali-offers', newPath: '/festive-offers', by: 'usr_admin', dropRedirectId: null });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'SITE_PAGE_ADDRESS_CHANGED',
      expect.objectContaining({ diff: { path: { before: '/diwali-offers', after: '/festive-offers' } }, metadata: expect.objectContaining({ retargeted: 2 }) }),
    );
  });

  it('moves back onto its own old address by dropping that redirect, and refuses another page\'s or another redirect\'s', async () => {
    repository.redirectFrom.mockResolvedValueOnce({ id: 'rd_own', fromPath: '/old-diwali', toPath: '/diwali-offers', pageId: 'sp_diwali' });
    await updatePage('diwali', { path: '/old-diwali' }, actor);
    expect(repository.changeAddress).toHaveBeenCalledWith(expect.objectContaining({ newPath: '/old-diwali', dropRedirectId: 'rd_own' }));

    repository.redirectFrom.mockResolvedValueOnce({ id: 'rd_other', fromPath: '/old-thing', toPath: '/spaces', pageId: 'sp_explore' });
    await expect(updatePage('diwali', { path: '/old-thing' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.pageAtPath.mockResolvedValueOnce(explore);
    await expect(updatePage('diwali', { path: '/spaces' }, actor)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps the home at "/", keeps a system page\'s parameter, and treats the same address as no change', async () => {
    await expect(updatePage('home', { path: '/welcome' }, actor)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/never changes/) });
    await expect(updatePage('listing', { path: '/ad-spaces' }, actor)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/keeps its parameter/) });
    await updatePage('listing', { path: '/ad-spaces/:id' }, actor);
    expect(repository.changeAddress).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'sp_listing', newPath: '/ad-spaces/:id' }));
    vi.clearAllMocks();
    await updatePage('diwali', { path: '/diwali-offers' }, actor);
    expect(repository.changeAddress).not.toHaveBeenCalled();
  });

  it('archives and restores a custom page only', async () => {
    await archivePage('diwali', actor);
    expect(repository.updatePage).toHaveBeenCalledWith('sp_diwali', { archivedAt: expect.any(Date) });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'SITE_PAGE_ARCHIVED', expect.anything());
    await expect(archivePage('explore', actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.findByKey.mockResolvedValueOnce(page({ archivedAt: NOW }));
    await restorePage('diwali', actor);
    expect(repository.updatePage).toHaveBeenCalledWith('sp_diwali', { archivedAt: null });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'SITE_PAGE_RESTORED', expect.anything());
  });

  it('hands a draft to the layouts desk under the page\'s key, and not on an archived page', async () => {
    await savePageDraft('diwali', { blocks: [] }, actor);
    expect(layouts.saveDraft).toHaveBeenCalledWith({ pageId: 'sp_diwali' }, { blocks: [] }, actor);
    await savePageDraft('explore', { blocks: [] }, actor);
    expect(layouts.saveDraft).toHaveBeenLastCalledWith({ surface: 'WEB_EXPLORE' }, { blocks: [] }, actor);
    repository.findByKey.mockResolvedValueOnce(page({ archivedAt: NOW }));
    await expect(savePageDraft('diwali', { blocks: [] }, actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('redirects', () => {
  it('writes a manual redirect, linked to the page it lands on, and audits', async () => {
    repository.pageAtPath.mockImplementation(async (path: string) => (path === '/spaces' ? explore : null));
    const redirect = await createRedirect({ fromPath: '/old-explore', toPath: '/spaces?city=pune' }, actor);
    expect(repository.createRedirect).toHaveBeenCalledWith({ fromPath: '/old-explore', toPath: '/spaces?city=pune', pageId: 'sp_explore', permanent: true, reason: 'MANUAL', createdByUserId: 'usr_admin' });
    expect(redirect).toMatchObject({ id: 'rd_1', page: { key: 'explore', title: 'Explore' } });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'SITE_REDIRECT_CREATED', expect.anything());
    await createRedirect({ fromPath: '/elsewhere', toPath: 'https://blog.adx.in/', permanent: false }, actor);
    expect(repository.createRedirect).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: null, permanent: false }));
  });

  it('refuses a bad source or destination, a loop, and a source that is a page or a redirect already', async () => {
    await expect(createRedirect({ fromPath: '/', toPath: '/spaces' }, actor)).rejects.toMatchObject({ statusCode: 400, details: { field: 'fromPath' } });
    await expect(createRedirect({ fromPath: '/old', toPath: 'ftp://x' }, actor)).rejects.toMatchObject({ statusCode: 400, details: { field: 'toPath' } });
    await expect(createRedirect({ fromPath: '/old', toPath: '/old' }, actor)).rejects.toMatchObject({ statusCode: 400 });
    repository.pageAtPath.mockResolvedValueOnce(explore);
    await expect(createRedirect({ fromPath: '/spaces', toPath: '/x' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.redirectFrom.mockResolvedValueOnce({ id: 'rd_9', fromPath: '/old', toPath: '/y', pageId: null });
    await expect(createRedirect({ fromPath: '/old', toPath: '/x' }, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createRedirect).not.toHaveBeenCalled();
  });

  it('deletes one, or 404s', async () => {
    repository.findRedirect.mockResolvedValueOnce({ id: 'rd_1', fromPath: '/a', toPath: '/b', reason: 'MANUAL' });
    await deleteRedirect('rd_1', actor);
    expect(repository.deleteRedirect).toHaveBeenCalledWith('rd_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'SITE_REDIRECT_DELETED', expect.anything());
    repository.findRedirect.mockResolvedValueOnce(null);
    await expect(deleteRedirect('rd_2', actor)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the public reads', () => {
  it('lists live pages and every redirect in the routing table, versioned and cached', async () => {
    repository.listPages.mockResolvedValue([home, listing, explore, page(), page({ id: 'sp_holi', key: 'holi', path: '/holi' }), page({ id: 'sp_gone', key: 'gone', path: '/gone', archivedAt: NOW })]);
    repository.currentVersions.mockResolvedValue([version({ pageId: 'sp_holi' }), version({ pageId: 'sp_gone' }), version({ number: 1, status: 'DRAFT' })]);
    repository.listRedirects.mockResolvedValue([{ id: 'rd_1', fromPath: '/old', toPath: '/spaces', permanent: true, reason: 'MANUAL', page: null, createdAt: NOW }]);
    const table = await routesTable();
    expect(table.pages.map((row) => row.key)).toEqual(['home', 'explore', 'listing', 'holi']);
    expect(table.pages[2]).toEqual({ key: 'listing', kind: 'SYSTEM', title: 'Listing page', path: '/spaces/:id', internalPath: '/spaces/:id', channels: ['WEBSITE'] });
    expect(table.redirects).toEqual([{ fromPath: '/old', toPath: '/spaces', permanent: true }]);
    expect(table.version).toMatch(/^[0-9a-f]{16}$/);
    expect((await routesTable()).version).toBe(table.version);
    expect(repository.listPages).toHaveBeenCalledTimes(1);
  });

  it('forgets the table on a write, and the version moves with the table', async () => {
    const before = (await routesTable()).version;
    await createRedirect({ fromPath: '/old', toPath: '/spaces' }, actor);
    repository.listRedirects.mockResolvedValue([{ id: 'rd_1', fromPath: '/old', toPath: '/spaces', permanent: true, reason: 'MANUAL', page: null, createdAt: NOW }]);
    const after = await routesTable();
    expect(repository.listPages).toHaveBeenCalledTimes(2);
    expect(after.version).not.toBe(before);
  });

  it('puts only indexable website pages in the sitemap', async () => {
    repository.listPages.mockResolvedValue([
      home,
      listing,
      explore,
      page(),
      page({ id: 'sp_holi', key: 'holi', path: '/holi' }),
      page({ id: 'sp_secret', key: 'secret', path: '/secret' }),
      page({ id: 'sp_app', key: 'app-only', path: '/app-only', channels: ['APPS'] }),
    ]);
    repository.currentVersions.mockResolvedValue([
      version({ surface: 'WEB_HOME', pageId: null, number: 3, publishedAt: new Date('2026-09-20T00:00:00Z') }),
      version({ pageId: 'sp_holi' }),
      version({ pageId: 'sp_secret', meta: { noindex: true } }),
      version({ pageId: 'sp_app' }),
    ]);
    const entries = await sitemap();
    expect(entries).toEqual([
      { path: '/', updatedAt: new Date('2026-09-20T00:00:00Z') },
      { path: '/holi', updatedAt: NOW },
      { path: '/spaces', updatedAt: NOW },
    ]);
  });

  it('resolves a live custom page, 404s an unpublished or archived one, and answers a system page from its surface or its defaults', async () => {
    await expect(resolvePage('diwali', {}, undefined)).rejects.toMatchObject({ statusCode: 404 });
    // "Nothing published" is cached like a live row; a publish forgets it (layouts does that) — here, by hand.
    layouts.getVersions.mockResolvedValue({ live: view({ number: 2, status: 'PUBLISHED', meta: { seoTitle: 'Diwali!' } }), draft: null });
    clearLayoutCache();
    layouts.getVersions.mockClear();
    const live = await resolvePage('diwali', {}, ['ADVERTISER']);
    expect(live).toMatchObject({ key: 'diwali', title: 'Diwali offers', path: '/diwali-offers', channels: ['WEBSITE'], version: 2, isDefault: false, meta: { seoTitle: 'Diwali!', noindex: false } });
    expect(live.blocks.map((block) => block.id)).toEqual(['h']);
    expect(live.preview).toBeUndefined();
    expect(layouts.resolveBlocks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ side: 'ADVERTISER', cityId: null }));
    await resolvePage('diwali', {}, ['ADVERTISER']);
    expect(layouts.getVersions).toHaveBeenCalledTimes(1);

    repository.findByKey.mockResolvedValueOnce(page({ archivedAt: NOW }));
    await expect(resolvePage('diwali', {}, undefined)).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolvePage('nope', {}, undefined)).rejects.toMatchObject({ statusCode: 404 });

    layouts.getVersions.mockResolvedValue({ live: null, draft: null });
    const system = await resolvePage('explore', {}, undefined);
    expect(system).toMatchObject({ key: 'explore', version: 0, isDefault: true });
    expect(system.blocks.map((block) => block.type)).toEqual(['explore_search', 'category_strip', 'campaign_strip', 'popular_rail', 'results']);
  });

  it('answers the draft, uncached, to a preview token for this page only', async () => {
    layouts.draftOrLive.mockResolvedValue({ number: 3, status: 'DRAFT', blocks: [{ id: 'd', type: 'hero', props: { headline: 'Draft' } }], meta: { seoTitle: 'Draft SEO' } });
    const { token } = signPreviewToken({ kind: 'page', ref: 'diwali' });
    const preview = await resolvePage('diwali', { preview: token }, undefined);
    expect(preview).toMatchObject({ version: 3, isDefault: false, preview: true, meta: { seoTitle: 'Draft SEO' } });
    expect(preview.blocks[0]!.id).toBe('d');
    await resolvePage('diwali', { preview: token }, undefined);
    expect(layouts.draftOrLive).toHaveBeenCalledTimes(2);

    // Another page's token is not a preview here.
    const other = signPreviewToken({ kind: 'page', ref: 'holi' }).token;
    await expect(resolvePage('diwali', { preview: other }, undefined)).rejects.toMatchObject({ statusCode: 404 });
    // Nothing at all to preview on a custom page is a 404 too.
    layouts.draftOrLive.mockResolvedValue(null);
    await expect(resolvePage('diwali', { preview: token }, undefined)).rejects.toMatchObject({ statusCode: 404 });
  });
});
