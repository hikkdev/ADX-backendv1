import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PB-1 (27 Sep 2026) — the page blocks, the custom scope, a version's SEO,
 * PAGE targets, the forms port and preview tokens.
 *
 * Pinned: thirteen page blocks in the registry, each held to its schema; a
 * custom page takes content blocks only; `meta` is checked like the blocks
 * (its picture must exist, be live and carry alt text) and travels with the
 * draft; every `PAGE` target gains the page's current address; a form block
 * resolves through the registered port and to null without one; a hero or a
 * column keeps drawing when its picture has gone, a picture block does not;
 * a preview token opens the draft of the one thing it names and nothing
 * else — never an authenticated route.
 */

const { repository, audit, media, content, flags, pricing } = vi.hoisted(() => ({
  repository: {
    currentRows: vi.fn(),
    live: vi.fn(),
    draft: vi.fn(),
    byNumber: vi.fn(),
    versions: vi.fn(),
    highestNumber: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    publishDraft: vi.fn(),
    publishCopy: vi.fn(),
    userNames: vi.fn(),
    cityStage: vi.fn(),
    slotByKey: vi.fn(),
    liveAds: vi.fn(),
    pagePaths: vi.fn(),
  },
  audit: { logActivity: vi.fn(async (..._args: unknown[]) => undefined) },
  media: { findMediaByIds: vi.fn() },
  content: { currentContentPage: vi.fn() },
  flags: { isFeatureEnabled: vi.fn(async () => true) },
  pricing: { citySupport: vi.fn() },
}));

vi.mock('../prisma-layouts.repository', () => ({ prismaLayoutsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity: audit.logActivity,
}));
vi.mock('../../media', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../media')>()), findMediaByIds: media.findMediaByIds }));
vi.mock('../../content', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../content')>()), currentContentPage: content.currentContentPage }));
vi.mock('../../feature-flags', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../feature-flags')>()), isFeatureEnabled: flags.isFeatureEnabled }));
vi.mock('../../pricing', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../pricing')>()), citySupport: pricing.citySupport }));

import { verifyAccessToken } from '../../../shared/auth';
import { CONTENT_TYPES, blockTypes, isVideoUrl, pageMetaSchema, validateBlocks, type Block } from '../block-registry';
import { assertValidMeta, blocksForPreview, publishDraft, restoreVersion, saveDraft } from '../layouts.service';
import { PREVIEW_TOKEN_TTL_SECONDS, signPreviewToken, verifyPreviewToken } from '../preview-token';
import { clearLayoutCache } from '../resolve.cache';
import {
  pageKeysIn,
  registerFormResolver,
  resetFormResolverForTests,
  resolveBlocks,
  resolveMeta,
  resolvePublic,
  sideFor,
  withPageHrefs,
  type ResolveContext,
} from '../resolve.service';

const NOW = new Date('2026-09-27T10:00:00Z');
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({ side: 'VISITOR', cityId: null, stage: null, now: NOW, ...over });
const actor = { userId: 'usr_admin' };

const asset = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  url: `http://x/${id}.jpg`,
  width: 1600,
  height: 480,
  altText: `Alt ${id}`,
  title: id,
  archivedAt: null,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'lv_1',
  surface: null,
  pageId: 'sp_diwali',
  number: 1,
  status: 'DRAFT',
  blocks: [],
  meta: null,
  changeNote: null,
  createdByUserId: 'usr_admin',
  publishedById: null,
  publishedAt: null,
  retiredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const hero = (over: Record<string, unknown> = {}): Block => ({ id: 'h', type: 'hero', props: { headline: 'Diwali offers', ...over } });
const toPage = (value: string) => ({ kind: 'PAGE', value });

beforeEach(() => {
  vi.clearAllMocks();
  clearLayoutCache();
  resetFormResolverForTests();
  repository.userNames.mockResolvedValue(new Map());
  repository.highestNumber.mockResolvedValue(0);
  repository.draft.mockResolvedValue(null);
  repository.live.mockResolvedValue(null);
  repository.pagePaths.mockResolvedValue(new Map());
  repository.createDraft.mockImplementation(async (data: Record<string, unknown>) => row({ ...data }));
  repository.updateDraft.mockImplementation(async (id: string, data: Record<string, unknown>) => row({ id, ...data }));
  media.findMediaByIds.mockImplementation(async (ids: string[]) =>
    ids
      .filter((id) => id !== 'nope')
      .map((id) => (id === 'square' ? asset(id, { width: 600, height: 600 }) : id === 'gone' ? asset(id, { archivedAt: NOW }) : id === 'mute' ? asset(id, { altText: null }) : asset(id))),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the registry', () => {
  it('lists the thirteen page blocks after the five of LM-1, with the console inputs the contract names', () => {
    expect(CONTENT_TYPES).toEqual([
      'promo_banner',
      'tile_grid',
      'listing_rail',
      'rich_text',
      'ad_slot',
      'hero',
      'cta_strip',
      'columns',
      'image',
      'video',
      'faq',
      'steps',
      'stats',
      'divider',
      'button_row',
      'category_tiles',
      'listing_grid',
      'form',
    ]);
    const types = blockTypes();
    const heroType = types.find((t) => t.type === 'hero')!;
    const cta = heroType.props.find((p) => p.key === 'primaryCta')!;
    expect(cta).toMatchObject({ input: 'cta' });
    expect(cta.of!.map((f) => f.input)).toEqual(['text', 'target']);
    expect(heroType.props.find((p) => p.key === 'mediaId')).toMatchObject({ input: 'media', spec: 'PROMO_WIDE' });
    expect(types.find((t) => t.type === 'form')!.props[0]).toMatchObject({ key: 'formKey', input: 'formKey', required: true });
    const grid = types.find((t) => t.type === 'listing_grid')!;
    expect(grid.props.map((p) => p.key)).toEqual(['title', 'source', 'value', 'listingIds', 'count', 'seeAllLabel', 'columns']);
    expect(types.find((t) => t.type === 'image')!.props[0]).toMatchObject({ input: 'media', required: true });
    expect(types.find((t) => t.type === 'image')!.props[0]!.spec).toBeUndefined();
  });

  it('takes a good page and normalises the defaults', () => {
    const { blocks, issues } = validateBlocks('CUSTOM', [
      hero({ primaryCta: { label: 'Go', target: toPage('diwali') } }),
      { id: 'c', type: 'cta_strip', props: { headline: 'Ready?', ctaLabel: 'Go', target: { kind: 'NEW_CAMPAIGN' } } },
      { id: 'cols', type: 'columns', props: { columns: [{ markdown: 'a' }, { markdown: 'b', title: 't', target: { kind: 'EXPLORE' } }] } },
      { id: 'i', type: 'image', props: { mediaId: 'wide' } },
      { id: 'v', type: 'video', props: { url: 'https://youtu.be/dQw4w9WgXcQ' } },
      { id: 'f', type: 'faq', props: { items: [{ question: 'Q?', answer: 'A.' }] } },
      { id: 's', type: 'steps', props: { items: [{ title: '1', body: 'a' }, { title: '2', body: 'b' }] } },
      { id: 'st', type: 'stats', props: { items: [{ value: '1', label: 'a' }, { value: '2', label: 'b' }] } },
      { id: 'd', type: 'divider', props: {} },
      { id: 'b', type: 'button_row', props: { buttons: [{ label: 'Go', target: { kind: 'ROUTE', value: '/spaces' } }] } },
      { id: 'ct', type: 'category_tiles', props: {} },
      { id: 'g', type: 'listing_grid', props: { title: 'Top', source: 'RATING', count: '6' } },
      { id: 'fm', type: 'form', props: { formKey: 'contact-us' } },
    ]);
    expect(issues).toEqual([]);
    expect(blocks[0]!.props['align']).toBe('LEFT');
    expect(blocks[1]!.props['tone']).toBe('BRAND');
    expect(blocks[3]!.props['width']).toBe('CONTAINED');
    expect(blocks[8]!.props['style']).toBe('LINE');
    expect((blocks[9]!.props['buttons'] as { style: string }[])[0]!.style).toBe('PRIMARY');
    expect(blocks[11]!.props).toMatchObject({ columns: 3, count: 6 });
  });

  it('refuses a system section on a custom page, and names each bad prop', () => {
    const { issues } = validateBlocks('CUSTOM', [
      { id: 'g', type: 'greeting' },
      { id: 'h', type: 'hero', props: {} },
      { id: 'c', type: 'columns', props: { columns: [{ markdown: 'only one' }] } },
      { id: 'v', type: 'video', props: { url: 'http://youtu.be/dQw4w9WgXcQ' } },
      { id: 's', type: 'stats', props: { items: [{ value: '1', label: 'a' }] } },
      { id: 'b', type: 'button_row', props: { buttons: [{ label: 'Go', target: { kind: 'PAGE' } }] } },
      { id: 'f', type: 'form', props: { formKey: 'Contact Us' } },
      { id: 'q', type: 'faq', props: { items: [] } },
    ]);
    expect(issues.map((i) => `${i.blockId}:${i.path}`)).toEqual([
      'g:type',
      'h:props.headline',
      'c:props.columns',
      'v:props.url',
      's:props.items',
      'b:props.buttons.0.target.value',
      'f:props.formKey',
      'q:props.items',
    ]);
    expect(issues[0]!.message).toMatch(/content blocks only/);
    // The same section is fine on its own surface.
    expect(validateBlocks('APP_ADVERTISER_HOME', [{ id: 'g', type: 'greeting' }]).issues).toEqual([]);
  });

  it('knows a video link', () => {
    expect(isVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isVideoUrl('https://youtube.com/embed/dQw4w9WgXcQ')).toBe(true);
    expect(isVideoUrl('https://vimeo.com/123456')).toBe(true);
    expect(isVideoUrl('https://player.vimeo.com/video/123456')).toBe(true);
    expect(isVideoUrl('https://cdn.adx.in/clips/reel.mp4?v=2')).toBe(true);
    expect(isVideoUrl('https://www.youtube.com/')).toBe(false);
    expect(isVideoUrl('https://example.com/clip.mov')).toBe(false);
    expect(isVideoUrl('http://vimeo.com/1')).toBe(false);
    expect(isVideoUrl('not a url')).toBe(false);
  });

  it('holds meta to its shape', () => {
    expect(pageMetaSchema.safeParse({ seoTitle: 'x', noindex: true }).success).toBe(true);
    expect(pageMetaSchema.safeParse({ ogTitle: 'x' }).success).toBe(false);
    expect(pageMetaSchema.safeParse({ seoTitle: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('a version with SEO', () => {
  it('cleans meta, or names the field, and checks its picture like a block', async () => {
    expect(await assertValidMeta(null)).toBeNull();
    expect(await assertValidMeta({ seoTitle: '  ', seoDescription: null, noindex: false })).toBeNull();
    expect(await assertValidMeta({ seoTitle: ' Diwali ', seoImageMediaId: 'square', noindex: true })).toEqual({ seoTitle: 'Diwali', seoImageMediaId: 'square', noindex: true });
    const shape = (await assertValidMeta({ ogTitle: 'x' }).catch((e: unknown) => e)) as { statusCode: number; details: { issues: { path: string }[] } };
    expect(shape.statusCode).toBe(400);
    expect(shape.details.issues[0]!.path).toMatch(/^meta/);
    const missing = (await assertValidMeta({ seoImageMediaId: 'nope' }).catch((e: unknown) => e)) as { details: { issues: { path: string; message: string }[] } };
    expect(missing.details.issues[0]).toMatchObject({ path: 'meta.seoImageMediaId', message: expect.stringMatching(/No picture/) });
    const silent = (await assertValidMeta({ seoImageMediaId: 'mute' }).catch((e: unknown) => e)) as { details: { issues: { message: string }[] } };
    expect(silent.details.issues[0]!.message).toMatch(/alt text/);
  });

  it('is saved with the draft on a page key, kept when left out, cleared with null', async () => {
    const view = await saveDraft({ pageId: 'sp_diwali' }, { blocks: [hero()], meta: { seoTitle: 'Diwali' } }, actor);
    expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({ key: { pageId: 'sp_diwali' }, number: 1, meta: { seoTitle: 'Diwali' } }));
    expect(view.meta).toEqual({ seoTitle: 'Diwali' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LAYOUT_DRAFTED', expect.objectContaining({ metadata: expect.objectContaining({ pageId: 'sp_diwali' }) }));

    repository.draft.mockResolvedValueOnce(row({ meta: { seoTitle: 'Old' } }));
    await saveDraft({ pageId: 'sp_diwali' }, { blocks: [hero()] }, actor);
    expect(repository.updateDraft).toHaveBeenLastCalledWith('lv_1', expect.objectContaining({ meta: { seoTitle: 'Old' } }));

    repository.draft.mockResolvedValueOnce(row({ meta: { seoTitle: 'Old' } }));
    await saveDraft({ pageId: 'sp_diwali' }, { blocks: [hero()], meta: null }, actor);
    expect(repository.updateDraft).toHaveBeenLastCalledWith('lv_1', expect.objectContaining({ meta: null }));
  });

  it('refuses a system section on a page key, and a page has no default layout to preview', async () => {
    await expect(saveDraft({ pageId: 'sp_diwali' }, { blocks: [{ id: 'g', type: 'greeting', props: {} }] }, actor)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.createDraft).not.toHaveBeenCalled();
    await expect(blocksForPreview({ pageId: 'sp_diwali' }, 0)).rejects.toMatchObject({ statusCode: 404 });
    expect(await blocksForPreview('WEB_HOME', 0)).toMatchObject({ number: 0, isDefault: true, meta: null });
  });

  it('travels through publish and restore', async () => {
    repository.draft.mockResolvedValueOnce(row({ blocks: [hero()], meta: { seoTitle: 'Diwali' } }));
    repository.publishDraft.mockResolvedValueOnce(row({ status: 'PUBLISHED', blocks: [hero()], meta: { seoTitle: 'Diwali' }, publishedAt: NOW }));
    const published = await publishDraft({ pageId: 'sp_diwali' }, {}, actor);
    expect(published.meta).toEqual({ seoTitle: 'Diwali' });
    expect(repository.publishDraft).toHaveBeenCalledWith('lv_1', { pageId: 'sp_diwali' }, 'usr_admin', expect.any(Date), null);

    repository.byNumber.mockResolvedValueOnce(row({ number: 1, status: 'RETIRED', blocks: [hero()], meta: { noindex: true } }));
    repository.highestNumber.mockResolvedValue(2);
    repository.publishCopy.mockImplementation(async (data: Record<string, unknown>) => row({ ...data, status: 'PUBLISHED' }));
    const restored = await restoreVersion({ pageId: 'sp_diwali' }, 1, actor);
    expect(repository.publishCopy).toHaveBeenCalledWith(expect.objectContaining({ key: { pageId: 'sp_diwali' }, number: 3, meta: { noindex: true } }));
    expect(restored.meta).toEqual({ noindex: true });
  });
});

describe('resolution of the page blocks', () => {
  it('adds media, hrefs, queries and the form; keeps a hero or a column without its picture; drops a picture block without one', async () => {
    repository.pagePaths.mockResolvedValue(new Map([['diwali', '/diwali-offers']]));
    registerFormResolver(async (key) => (key === 'contact-us' ? { key, title: 'Contact', description: null, audience: 'PUBLIC', version: 2, definition: { screens: [] } } : null));
    const blocks: Block[] = [
      hero({ mediaId: 'wide', primaryCta: { label: 'Go', target: toPage('diwali') }, secondaryCta: { label: 'Later', target: toPage('unknown-page') } }),
      { id: 'h2', type: 'hero', props: { headline: 'No picture now', mediaId: 'gone' } },
      { id: 'c', type: 'columns', props: { columns: [{ markdown: 'a', mediaId: 'square', target: toPage('diwali') }, { markdown: 'b', mediaId: 'gone' }] } },
      { id: 'i1', type: 'image', props: { mediaId: 'wide', width: 'FULL' } },
      { id: 'i2', type: 'image', props: { mediaId: 'gone' } },
      { id: 'g', type: 'listing_grid', props: { title: 'Top', source: 'CATEGORY', value: 'INDOOR', count: 4, columns: 2 } },
      { id: 'f1', type: 'form', props: { formKey: 'contact-us' } },
      { id: 'f2', type: 'form', props: { formKey: 'retired' } },
      { id: 'b', type: 'button_row', props: { buttons: [{ label: 'Go', target: toPage('diwali'), style: 'PRIMARY' }] } },
      { id: 'cta', type: 'cta_strip', props: { headline: 'Ready?', ctaLabel: 'Go', target: { kind: 'NEW_CAMPAIGN' }, tone: 'INK' } },
      { id: 'v', type: 'video', props: { url: 'https://vimeo.com/1' } },
      { id: 'd', type: 'divider', props: { style: 'SPACE' } },
      { id: 'ct', type: 'category_tiles', props: { title: 'Browse' } },
    ];
    const resolved = await resolveBlocks(blocks, ctx());
    expect(resolved.map((b) => b.id)).toEqual(['h', 'h2', 'c', 'i1', 'g', 'f1', 'f2', 'b', 'cta', 'v', 'd', 'ct']);
    const byId = Object.fromEntries(resolved.map((b) => [b.id, b.props]));
    expect(byId['h']!['media']).toEqual({ url: 'http://x/wide.jpg', width: 1600, height: 480, altText: 'Alt wide' });
    expect(byId['h']!['primaryCta']).toEqual({ label: 'Go', target: { kind: 'PAGE', value: 'diwali', href: '/diwali-offers' } });
    expect(byId['h']!['secondaryCta']).toEqual({ label: 'Later', target: { kind: 'PAGE', value: 'unknown-page' } });
    expect(byId['h2']).toEqual({ headline: 'No picture now' });
    const columns = byId['c']!['columns'] as Record<string, unknown>[];
    expect(columns[0]).toMatchObject({ media: expect.objectContaining({ url: 'http://x/square.jpg' }), target: { kind: 'PAGE', value: 'diwali', href: '/diwali-offers' } });
    expect(columns[1]).toEqual({ markdown: 'b' });
    expect(byId['i1']!['media']).toMatchObject({ url: 'http://x/wide.jpg' });
    expect(byId['g']!['query']).toEqual({ category: 'INDOOR', pageSize: 4 });
    expect(byId['f1']!['form']).toMatchObject({ key: 'contact-us', version: 2 });
    expect(byId['f2']!['form']).toBeNull();
    expect((byId['b']!['buttons'] as { target: unknown }[])[0]!.target).toEqual({ kind: 'PAGE', value: 'diwali', href: '/diwali-offers' });
    expect(byId['cta']).toEqual({ headline: 'Ready?', ctaLabel: 'Go', target: { kind: 'NEW_CAMPAIGN' }, tone: 'INK' });
    expect(repository.pagePaths).toHaveBeenCalledWith(expect.arrayContaining(['diwali', 'unknown-page']));
  });

  it('resolves no form without a port, and a port that throws resolves to null', async () => {
    expect((await resolveBlocks([{ id: 'f', type: 'form', props: { formKey: 'x' } }], ctx()))[0]!.props['form']).toBeNull();
    registerFormResolver(async () => {
      throw new Error('forms down');
    });
    expect((await resolveBlocks([{ id: 'f', type: 'form', props: { formKey: 'x' } }], ctx()))[0]!.props['form']).toBeNull();
  });

  it('walks props for page keys and adds hrefs without touching anything else', () => {
    const props = { a: { target: toPage('one') }, list: [{ target: toPage('two') }, { target: { kind: 'URL', value: 'https://x' } }], media: { url: 'u' } };
    expect([...pageKeysIn(props)]).toEqual(['one', 'two']);
    const out = withPageHrefs(props, new Map([['one', '/one']]));
    expect(out.a.target).toEqual({ kind: 'PAGE', value: 'one', href: '/one' });
    expect(out.list[0]!.target).toEqual({ kind: 'PAGE', value: 'two' });
    expect(out.list[1]!.target).toEqual({ kind: 'URL', value: 'https://x' });
    expect(out.media).toEqual({ url: 'u' });
    expect(props.a.target).toEqual({ kind: 'PAGE', value: 'one' });
  });

  it('resolves meta with its picture, every field present', async () => {
    expect(await resolveMeta(null)).toEqual({ seoTitle: null, seoDescription: null, seoImage: null, noindex: false });
    expect(await resolveMeta({ seoTitle: 'T', seoImageMediaId: 'wide', noindex: true })).toEqual({
      seoTitle: 'T',
      seoDescription: null,
      seoImage: { url: 'http://x/wide.jpg', width: 1600, height: 480, altText: 'Alt wide' },
      noindex: true,
    });
    expect((await resolveMeta({ seoImageMediaId: 'gone' })).seoImage).toBeNull();
  });

  it('reads a side for a page that is for no side in particular — the account\'s first side, in the sides\' own order', () => {
    expect(sideFor(null, ['PUBLISHER', 'ADVERTISER'])).toBe('ADVERTISER');
    expect(sideFor(null, ['AGENT_PUBLISHER'])).toBe('AGENT_FIELD');
    expect(sideFor(null, undefined)).toBe('VISITOR');
    expect(sideFor(null, ['ADVERTISER'], 'VISITOR')).toBe('VISITOR');
  });
});

describe('a surface previewed', () => {
  it('answers the draft, uncached, with a preview; the live version otherwise', async () => {
    repository.draft.mockResolvedValue(row({ surface: 'WEB_HOME', pageId: null, number: 5, blocks: [hero({ headline: 'Draft' })], meta: { seoTitle: 'Draft SEO' } }));
    repository.live.mockResolvedValue(row({ surface: 'WEB_HOME', pageId: null, number: 4, status: 'PUBLISHED', blocks: [hero({ headline: 'Live' })] }));
    const draft = await resolvePublic('WEB_HOME', ctx(), true);
    expect(draft).toMatchObject({ version: 5, isDefault: false, preview: true, meta: { seoTitle: 'Draft SEO' } });
    expect(draft.blocks[0]!.props['headline']).toBe('Draft');
    await resolvePublic('WEB_HOME', ctx(), true);
    expect(repository.draft).toHaveBeenCalledTimes(2);

    const live = await resolvePublic('WEB_HOME', ctx());
    expect(live).toMatchObject({ version: 4, isDefault: false, meta: { seoTitle: null } });
    expect(live.preview).toBeUndefined();
    expect(live.blocks[0]!.props['headline']).toBe('Live');
  });

  it('falls back to what is live, then the defaults, when there is no draft', async () => {
    repository.live.mockResolvedValue(row({ surface: 'WEB_HOME', pageId: null, number: 2, status: 'PUBLISHED', blocks: [hero({ headline: 'Live' })] }));
    expect((await resolvePublic('WEB_HOME', ctx(), true)).version).toBe(2);
    repository.live.mockResolvedValue(null);
    expect(await resolvePublic('WEB_HOME', ctx(), true)).toMatchObject({ version: 0, isDefault: true, preview: true });
  });
});

describe('preview tokens', () => {
  it('open exactly the one thing they name, for a day, and never an authenticated route', () => {
    const { token, expiresAt } = signPreviewToken({ kind: 'page', ref: 'diwali' }, NOW);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(PREVIEW_TOKEN_TTL_SECONDS * 1000);
    expect(verifyPreviewToken(token, { kind: 'page', ref: 'diwali' })).toBe(true);
    expect(verifyPreviewToken(token, { kind: 'page', ref: 'other' })).toBe(false);
    expect(verifyPreviewToken(token, { kind: 'surface', ref: 'diwali' })).toBe(false);
    expect(verifyPreviewToken('not.a.token', { kind: 'page', ref: 'diwali' })).toBe(false);
    expect(verifyPreviewToken(undefined, { kind: 'page', ref: 'diwali' })).toBe(false);
    expect(() => verifyAccessToken(token)).toThrow(/Not an access token/);
  });

  it('expire', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { token } = signPreviewToken({ kind: 'surface', ref: 'WEB_HOME' });
    expect(verifyPreviewToken(token, { kind: 'surface', ref: 'WEB_HOME' })).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + (PREVIEW_TOKEN_TTL_SECONDS + 60) * 1000));
    expect(verifyPreviewToken(token, { kind: 'surface', ref: 'WEB_HOME' })).toBe(false);
  });
});
