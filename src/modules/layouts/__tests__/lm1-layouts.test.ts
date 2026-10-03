import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LM-1 — the layout desk and the resolution.
 *
 * Desk: one draft per surface, created or replaced; a picture must exist,
 * be live, carry alt text and be the shape its place draws; publishing
 * re-checks and retires the live one; a restore publishes a copy as the
 * newest version; every write is audited.
 *
 * Resolution: hidden, out-of-schedule and mistargeted blocks drop; media,
 * rail queries, published text and live ads are added in props; anything
 * that cannot be drawn drops its block; nothing published answers the
 * defaults as version 0; the answer is cached per caller and the ads are
 * dealt fresh each read.
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

import { discardDraft, listSurfaces, parseSurface, publishDraft, restoreVersion, saveDraft } from '../layouts.service';
import { isVisible, placeFor, railQuery, resolveBlocks, resolvePublic, shuffleAds, sideFor, type ResolveContext } from '../resolve.service';
import { clearLayoutCache } from '../resolve.cache';
import { defaultBlocks, type Block } from '../block-registry';

const NOW = new Date('2026-09-27T10:00:00Z');
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({ side: 'ADVERTISER', cityId: 'city_pune', stage: 'LAUNCHED', now: NOW, ...over });

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
  surface: 'APP_ADVERTISER_HOME',
  number: 1,
  status: 'DRAFT',
  blocks: [],
  changeNote: null,
  createdByUserId: 'usr_admin',
  publishedById: null,
  publishedAt: null,
  retiredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const banner: Block = { id: 'b1', type: 'promo_banner', props: { mediaId: 'wide', aspect: 'WIDE', target: { kind: 'EXPLORE' } } };
const actor = { userId: 'usr_admin' };

beforeEach(() => {
  vi.clearAllMocks();
  clearLayoutCache();
  repository.userNames.mockResolvedValue(new Map([['usr_admin', 'Asha Admin']]));
  repository.highestNumber.mockResolvedValue(0);
  repository.createDraft.mockImplementation(async (data: Record<string, unknown>) => row({ ...data }));
  repository.updateDraft.mockImplementation(async (id: string, data: Record<string, unknown>) => row({ id, ...data }));
  media.findMediaByIds.mockImplementation(async (ids: string[]) =>
    ids.filter((id) => id !== 'nope').map((id) => (id === 'square' ? asset(id, { width: 600, height: 600 }) : id === 'gone' ? asset(id, { archivedAt: NOW }) : id === 'mute' ? asset(id, { altText: null }) : asset(id))),
  );
});

describe('the desk', () => {
  it('reads a surface from the path either way, and 404s an unknown one', () => {
    expect(parseSurface('app-advertiser-home')).toBe('APP_ADVERTISER_HOME');
    expect(() => parseSurface('BILLBOARD')).toThrow(/No such layout surface/);
  });

  it('lists all thirteen surfaces with what is live and what waits', async () => {
    repository.currentRows.mockResolvedValue([
      row({ surface: 'WEB_HOME', number: 2, status: 'PUBLISHED', publishedAt: NOW }),
      row({ surface: 'WEB_HOME', number: 3, status: 'DRAFT' }),
    ]);
    const list = await listSurfaces();
    // PB-3 added the website's five other pages to LM-1's eight.
    expect(list).toHaveLength(13);
    expect(list[0]).toEqual({ surface: 'WEB_HOME', label: 'Website — Home page', live: { number: 2, publishedAt: NOW }, draft: { number: 3, updatedAt: NOW } });
    expect(list[1]!.live).toBeNull();
  });

  it('creates the next draft, then replaces it, auditing both', async () => {
    repository.draft.mockResolvedValueOnce(null);
    repository.highestNumber.mockResolvedValue(4);
    const first = await saveDraft('APP_ADVERTISER_HOME', { blocks: [banner], changeNote: 'Launch' }, actor);
    expect(first.number).toBe(5);
    // PB-1: the repository is keyed `{ surface } | { pageId }` since custom pages share the desk.
    expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({ key: { surface: 'APP_ADVERTISER_HOME' }, number: 5, changeNote: 'Launch', meta: null }));
    repository.draft.mockResolvedValueOnce(row({ number: 5, changeNote: 'Launch' }));
    await saveDraft('APP_ADVERTISER_HOME', { blocks: [banner] }, actor);
    expect(repository.updateDraft).toHaveBeenCalledWith('lv_1', expect.objectContaining({ changeNote: 'Launch' }));
    expect(audit.logActivity.mock.calls.map((c) => c[1])).toEqual(['LAYOUT_DRAFTED', 'LAYOUT_DRAFT_EDITED']);
  });

  it('refuses a picture that is missing, archived, silent or the wrong shape', async () => {
    const blocks = [
      { ...banner, id: 'a', props: { ...banner.props, mediaId: 'nope' } },
      { ...banner, id: 'b', props: { ...banner.props, mediaId: 'gone' } },
      { ...banner, id: 'c', props: { ...banner.props, mediaId: 'mute' } },
      { ...banner, id: 'd', props: { ...banner.props, mediaId: 'square' } },
      { id: 'e', type: 'tile_grid', props: { tiles: [{ mediaId: 'wide', label: 'x', target: { kind: 'EXPLORE' } }] } },
    ];
    const err = (await saveDraft('APP_ADVERTISER_HOME', { blocks }, actor).catch((e: unknown) => e)) as { statusCode: number; details: { issues: { blockId: string; message: string }[] } };
    expect(err.statusCode).toBe(400);
    expect(err.details.issues.map((i) => i.blockId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(err.details.issues[3]!.message).toMatch(/Promo banner — wide/);
    expect(err.details.issues[4]!.message).toMatch(/Tile/);
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it('publishes the draft, re-checked, and says who', async () => {
    repository.draft.mockResolvedValue(row({ blocks: [banner] }));
    repository.publishDraft.mockResolvedValue(row({ status: 'PUBLISHED', blocks: [banner], publishedById: 'usr_admin', publishedAt: NOW }));
    const view = await publishDraft('APP_ADVERTISER_HOME', { changeNote: 'Go' }, actor);
    expect(repository.publishDraft).toHaveBeenCalledWith('lv_1', { surface: 'APP_ADVERTISER_HOME' }, 'usr_admin', expect.any(Date), 'Go');
    expect(view.publishedBy).toEqual({ id: 'usr_admin', name: 'Asha Admin' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'LAYOUT_PUBLISHED', expect.anything());
  });

  it('will not publish nothing, nor a draft whose picture was archived since', async () => {
    repository.draft.mockResolvedValueOnce(null);
    await expect(publishDraft('WEB_HOME', {}, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.draft.mockResolvedValueOnce(row({ blocks: [{ ...banner, props: { ...banner.props, mediaId: 'gone' } }] }));
    await expect(publishDraft('APP_ADVERTISER_HOME', {}, actor)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.publishDraft).not.toHaveBeenCalled();
  });

  it('restores an old version as the newest, and refuses the live one and the draft', async () => {
    repository.byNumber.mockResolvedValueOnce(row({ number: 2, status: 'RETIRED', blocks: [banner] }));
    repository.highestNumber.mockResolvedValue(6);
    repository.publishCopy.mockImplementation(async (data: Record<string, unknown>) => row({ ...data, status: 'PUBLISHED' }));
    const view = await restoreVersion('APP_ADVERTISER_HOME', 2, actor);
    expect(view).toMatchObject({ number: 7, status: 'PUBLISHED', changeNote: 'Restored from version 2' });
    repository.byNumber.mockResolvedValueOnce(row({ status: 'PUBLISHED' }));
    await expect(restoreVersion('APP_ADVERTISER_HOME', 1, actor)).rejects.toMatchObject({ statusCode: 409 });
    repository.byNumber.mockResolvedValueOnce(null);
    await expect(restoreVersion('APP_ADVERTISER_HOME', 9, actor)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('discards the draft, or 404s when there is none', async () => {
    repository.draft.mockResolvedValueOnce(row());
    await discardDraft('WEB_HOME', actor);
    expect(repository.deleteDraft).toHaveBeenCalledWith('lv_1');
    repository.draft.mockResolvedValueOnce(null);
    await expect(discardDraft('WEB_HOME', actor)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('who is looking, and where', () => {
  it('reads the side the client names, else the one the surface is for, else the first the account has', () => {
    expect(sideFor('WEB_HOME', undefined)).toBe('VISITOR');
    expect(sideFor('WEB_HOME', ['ADVERTISER'], 'PUBLISHER')).toBe('PUBLISHER');
    expect(sideFor('APP_PUBLISHER_HOME', ['ADVERTISER', 'PUBLISHER'])).toBe('PUBLISHER');
    expect(sideFor('AGENT_HOME', ['AGENT_ADVERTISER'])).toBe('AGENT_SALES');
    expect(sideFor('WEB_HOME', ['ADMIN'])).toBe('VISITOR');
  });

  it('resolves a typed city to its catalogue id and stage, and a bare id to its stage', async () => {
    pricing.citySupport.mockResolvedValue({ city: { id: 'city_pune' }, stage: 'LAUNCHED' });
    expect(await placeFor({ city: 'pune' })).toEqual({ cityId: 'city_pune', stage: 'LAUNCHED' });
    repository.cityStage.mockResolvedValue('SEEDING');
    expect(await placeFor({ cityId: 'city_x' })).toEqual({ cityId: 'city_x', stage: 'SEEDING' });
    expect(await placeFor({ cityId: 'city_x', stage: 'PAUSED' })).toEqual({ cityId: 'city_x', stage: 'PAUSED' });
    expect(await placeFor({})).toEqual({ cityId: null, stage: null });
  });

  it('drops a block that is hidden, out of schedule or targeted elsewhere', () => {
    const g = (over: Partial<Block>): Block => ({ id: 'g', type: 'greeting', props: {}, ...over });
    expect(isVisible(g({}), ctx())).toBe(true);
    expect(isVisible(g({ hidden: true }), ctx())).toBe(false);
    expect(isVisible(g({ schedule: { startsAt: '2026-09-28T00:00:00Z' } }), ctx())).toBe(false);
    expect(isVisible(g({ schedule: { endsAt: '2026-09-27T10:00:00Z' } }), ctx())).toBe(false);
    expect(isVisible(g({ visibility: { sides: ['VISITOR'] } }), ctx())).toBe(false);
    expect(isVisible(g({ visibility: { cityIds: ['city_pune'] } }), ctx())).toBe(true);
    expect(isVisible(g({ visibility: { cityIds: ['city_pune'] } }), ctx({ cityId: null }))).toBe(false);
    expect(isVisible(g({ visibility: { stages: ['SEEDING'] } }), ctx())).toBe(false);
  });

  it('turns a rail into the browse query it stands for', () => {
    expect(railQuery({ source: 'RATING', count: 6 })).toEqual({ sort: 'RATING', pageSize: 6 });
    expect(railQuery({ source: 'NEAR_YOU', count: 4 })).toEqual({ near: true, pageSize: 4 });
    expect(railQuery({ source: 'VENUE', value: 'vt_1', count: 4 })).toEqual({ venueTypeId: 'vt_1', pageSize: 4 });
    expect(railQuery({ source: 'CURATED', listingIds: ['a', 'b', 'c'], count: 2 })).toEqual({ ids: ['a', 'b'], pageSize: 2 });
  });
});

describe('resolution', () => {
  it('adds media, queries, text and live ads in props, and drops what cannot be drawn', async () => {
    content.currentContentPage.mockImplementation(async (slug: string) => {
      if (slug === 'how') return { body: '# How' };
      throw new Error('404');
    });
    repository.slotByKey.mockImplementation(async (key: string) => (key === 'SIDE' ? { id: 'slot_1', key, label: 'Sidebar', spec: 'AD_SIDEBAR', isActive: true } : null));
    repository.liveAds.mockResolvedValue([
      { id: 'adb_1', displayId: 'ADB-1', mediaId: 'art', headline: 'Diwali', ctaLabel: 'Go', targetUrl: 'https://e.x', cityIds: [] },
      { id: 'adb_2', displayId: 'ADB-2', mediaId: 'gone', headline: null, ctaLabel: null, targetUrl: null, cityIds: [] },
    ]);
    const blocks: Block[] = [
      banner,
      { ...banner, id: 'b2', props: { ...banner.props, mediaId: 'gone' } },
      { id: 't', type: 'tile_grid', props: { tiles: [{ mediaId: 'square', label: 'A', target: { kind: 'EXPLORE' } }, { mediaId: 'gone', label: 'B', target: { kind: 'EXPLORE' } }] } },
      { id: 'r', type: 'listing_rail', props: { title: 'Top', source: 'NEWEST', count: 3 } },
      { id: 'x1', type: 'rich_text', props: { contentSlug: 'how' } },
      { id: 'x2', type: 'rich_text', props: { contentSlug: 'taken-down' } },
      { id: 'x3', type: 'rich_text', props: { markdown: 'Hi' } },
      { id: 's1', type: 'ad_slot', props: { slotKey: 'SIDE' } },
      { id: 's2', type: 'ad_slot', props: { slotKey: 'GONE' } },
      { id: 'q', type: 'mystery', props: {} },
      { id: 'g', type: 'greeting', props: { title: 'Hello' } },
    ];
    const resolved = await resolveBlocks(blocks, ctx());
    expect(resolved.map((b) => b.id)).toEqual(['b1', 't', 'r', 'x1', 'x3', 's1', 'g']);
    expect(resolved[0]!.props['media']).toEqual({ url: 'http://x/wide.jpg', width: 1600, height: 480, altText: 'Alt wide' });
    expect((resolved[1]!.props['tiles'] as unknown[]).length).toBe(1);
    expect(resolved[2]!.props['query']).toEqual({ sort: 'NEWEST', pageSize: 3 });
    expect(resolved[3]!.props['markdown']).toBe('# How');
    expect(resolved[5]!.props['slot']).toEqual({ key: 'SIDE', label: 'Sidebar', spec: 'AD_SIDEBAR' });
    expect(resolved[5]!.props['ads']).toEqual([
      { adBookingId: 'adb_1', displayId: 'ADB-1', media: { url: 'http://x/art.jpg', width: 1600, height: 480, altText: 'Alt art' }, headline: 'Diwali', ctaLabel: 'Go', targetUrl: 'https://e.x' },
    ]);
    expect(repository.liveAds).toHaveBeenCalledWith('slot_1', new Date('2026-09-27T00:00:00Z'), 'city_pune');
    expect(resolved[6]).toEqual({ id: 'g', type: 'greeting', props: { title: 'Hello' } });
  });

  it('draws no ads when the switch is off, and keeps the slot empty rather than inventing any', async () => {
    repository.slotByKey.mockResolvedValue({ id: 'slot_1', key: 'SIDE', label: 'Sidebar', spec: 'AD_SIDEBAR', isActive: true });
    flags.isFeatureEnabled.mockResolvedValueOnce(false);
    const { feature, resetRegistryForTests } = await import('../../../shared/features');
    feature('promotions.ads', { surfaces: ['BACKEND'], owner: 'test', kind: 'FEATURE', launch: 'on', description: 'test' });
    const [slot] = await resolveBlocks([{ id: 's', type: 'ad_slot', props: { slotKey: 'SIDE' } }], ctx());
    expect(slot!.props['ads']).toEqual([]);
    expect(repository.liveAds).not.toHaveBeenCalled();
    resetRegistryForTests();
  });

  it('deals the ads in a fresh order each read', () => {
    const block = { id: 's', type: 'ad_slot', props: { ads: [1, 2, 3] } };
    expect(shuffleAds([block], () => 0)[0]!.props['ads']).toEqual([2, 3, 1]);
    expect(block.props.ads).toEqual([1, 2, 3]);
  });

  it('answers the defaults as version 0 when nothing is published, and caches per caller', async () => {
    repository.live.mockResolvedValue(null);
    const first = await resolvePublic('APP_ADVERTISER_HOME', ctx());
    expect(first).toMatchObject({ surface: 'APP_ADVERTISER_HOME', version: 0, isDefault: true });
    expect(first.blocks.map((b) => b.type)).toEqual(defaultBlocks('APP_ADVERTISER_HOME').map((b) => b.type));
    await resolvePublic('APP_ADVERTISER_HOME', ctx());
    expect(repository.live).toHaveBeenCalledTimes(1);
  });

  it('answers the published version when there is one', async () => {
    repository.live.mockResolvedValue(row({ number: 4, status: 'PUBLISHED', blocks: [banner, { id: 'v', type: 'greeting', props: {}, visibility: { sides: ['VISITOR'] } }] }));
    const layout = await resolvePublic('APP_ADVERTISER_HOME', ctx());
    expect(layout).toMatchObject({ version: 4, isDefault: false });
    expect(layout.blocks.map((b) => b.id)).toEqual(['b1']);
    const visitor = await resolvePublic('APP_ADVERTISER_HOME', ctx({ side: 'VISITOR' }));
    expect(visitor.blocks.map((b) => b.id)).toEqual(['b1', 'v']);
  });
});
