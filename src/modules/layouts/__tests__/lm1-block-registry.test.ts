import { describe, expect, it } from 'vitest';
import {
  LAYOUT_SURFACES,
  SURFACE_DEFAULT_ORDER,
  blockTypes,
  defaultBlocks,
  stableBlockId,
  surfacesOfSystem,
  validateBlocks,
} from '../block-registry';

/**
 * LM-1 — the block registry.
 *
 * Pinned: every surface's default layout is its sections in the contract's
 * order with stable ids; the console's descriptor lists every type with its
 * surfaces and a form; a layout is refused for an unknown type, a system
 * block off its surface or twice, a repeated id, a prop that fails its
 * type, and — on the explore page — a results grid that is not last,
 * hidden or targeted; everything wrong is named at once.
 */

const banner = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  type: 'promo_banner',
  props: { mediaId: 'med_1', aspect: 'WIDE', target: { kind: 'ROUTE', value: '/spaces' }, ...over },
});

describe('defaults', () => {
  it('are each surface in the contract order', () => {
    expect(SURFACE_DEFAULT_ORDER.APP_ADVERTISER_HOME).toEqual(['greeting', 'setup_card', 'search_bar', 'category_mosaic', 'popular_rail', 'nearby_listings', 'campaign_summary_strip']);
    expect(SURFACE_DEFAULT_ORDER.AGENT_HOME).toEqual(['tier_header', 'quick_tiles', 'tasks_card', 'agent_map']);
    expect(SURFACE_DEFAULT_ORDER.WEB_HOME).toEqual(['legacy_home']);
    expect(defaultBlocks('WEB_LISTING')).toEqual([
      { id: stableBlockId('WEB_LISTING', 'publisher_listings'), type: 'publisher_listings', props: {} },
      { id: stableBlockId('WEB_LISTING', 'ad_slot'), type: 'ad_slot', props: { slotKey: 'WEB_LISTING_SIDEBAR' } },
    ]);
  });

  it('have stable, uuid-shaped ids, and every default validates on its own surface', () => {
    expect(stableBlockId('WEB_HOME', 'legacy_home')).toBe(stableBlockId('WEB_HOME', 'legacy_home'));
    expect(stableBlockId('WEB_HOME', 'legacy_home')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const surface of LAYOUT_SURFACES) expect(validateBlocks(surface, defaultBlocks(surface)).issues).toEqual([]);
  });

  it('put a shared section on every surface that has it', () => {
    expect(surfacesOfSystem('quick_tiles')).toEqual(['APP_PUBLISHER_HOME', 'AGENT_HOME']);
    expect(surfacesOfSystem('popular_rail')).toEqual(['WEB_EXPLORE', 'APP_ADVERTISER_HOME']);
  });
});

describe('the descriptor the console builds forms from', () => {
  it('lists every system section and the content blocks — the five of LM-1 first, then PB-1\'s thirteen page blocks', () => {
    const types = blockTypes();
    const content = types.filter((t) => t.kind === 'CONTENT').map((t) => t.type);
    expect(content.slice(0, 5)).toEqual(['promo_banner', 'tile_grid', 'listing_rail', 'rich_text', 'ad_slot']);
    expect(content.slice(5)).toEqual(['hero', 'cta_strip', 'columns', 'image', 'video', 'faq', 'steps', 'stats', 'divider', 'button_row', 'category_tiles', 'listing_grid', 'form']);
    expect(types.find((t) => t.type === 'ad_slot')!.surfaces).toEqual([...LAYOUT_SURFACES]);
    expect(types.find((t) => t.type === 'category_mosaic')!.props).toEqual([expect.objectContaining({ key: 'title', input: 'text' })]);
    expect(types.find((t) => t.type === 'greeting')!.props).toEqual([]);
    const tiles = types.find((t) => t.type === 'tile_grid')!.props.find((p) => p.key === 'tiles')!;
    expect(tiles).toMatchObject({ input: 'list', min: 1, max: 12 });
    expect(tiles.of!.map((f) => f.input)).toEqual(['media', 'text', 'target']);
    for (const t of types) expect(t.surfaces.length).toBeGreaterThan(0);
  });
});

describe('validation', () => {
  it('takes a good content block and normalises its props', () => {
    const { blocks, issues } = validateBlocks('APP_ADVERTISER_HOME', [
      banner(),
      { id: 't', type: 'tile_grid', props: { columns: '3', tiles: [{ mediaId: 'm', label: 'Malls', target: { kind: 'CATEGORY', value: 'INDOOR' } }] } },
      { id: 'r', type: 'listing_rail', props: { title: 'Top', source: 'CATEGORY', value: 'OUTDOOR', count: '4' } },
      { id: 'x', type: 'rich_text', props: { contentSlug: 'how-it-works' } },
      { id: 'a', type: 'ad_slot', props: { slotKey: 'WEB_LISTING_SIDEBAR' }, visibility: { sides: ['VISITOR'], stages: ['LAUNCHED'] } },
    ]);
    expect(issues).toEqual([]);
    expect(blocks[1]!.props['columns']).toBe(3);
    expect(blocks[2]!.props['count']).toBe(4);
  });

  it('names every problem at once, with the block and the prop', () => {
    const { issues } = validateBlocks('APP_ADVERTISER_HOME', [
      { id: 'u', type: 'carousel' },
      { id: 'o', type: 'occupancy_gauge' },
      { id: 'g', type: 'greeting' },
      { id: 'g2', type: 'greeting' },
      banner({ target: { kind: 'URL', value: 'ftp://x' } }),
      { id: 'b1', type: 'rich_text', props: { markdown: 'x', contentSlug: 'y' } },
      { id: 'r', type: 'listing_rail', props: { title: 'x', source: 'CURATED', count: 3 } },
      { id: 'c', type: 'listing_rail', props: { title: 'x', source: 'CATEGORY', value: 'SKY', count: 3 } },
      { id: 's', type: 'ad_slot', props: { slotKey: 'lower' } },
      { id: 'w', type: 'greeting', schedule: { startsAt: '2026-10-02T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' } },
    ]);
    const byBlock = issues.map((i) => `${i.blockId}:${i.path}`);
    expect(byBlock).toEqual([
      'u:type',
      'o:type',
      'g2:type',
      'b1:props.target.value',
      'b1:id',
      'b1:props',
      'r:props.listingIds',
      'c:props.value',
      's:props.slotKey',
      'w:schedule.endsAt',
    ]);
  });

  it('refuses unknown targeting values and too many blocks', () => {
    expect(validateBlocks('WEB_HOME', [{ id: 'l', type: 'legacy_home', visibility: { sides: ['ROBOT'] } }]).issues).toHaveLength(1);
    const many = Array.from({ length: 41 }, (_, i) => ({ id: `r${i}`, type: 'rich_text', props: { markdown: 'x' } }));
    expect(validateBlocks('WEB_HOME', many).issues[0]!.message).toMatch(/At most 40/);
    expect(validateBlocks('WEB_HOME', 'nope').issues).toHaveLength(1);
  });

  it('keeps the explore results last, shown and untargeted', () => {
    expect(validateBlocks('WEB_EXPLORE', [{ id: 'e', type: 'explore_search' }]).issues[0]!.message).toMatch(/always on/);
    expect(validateBlocks('WEB_EXPLORE', [{ id: 'r', type: 'results' }, { id: 'e', type: 'explore_search' }]).issues[0]!.message).toMatch(/last/);
    expect(validateBlocks('WEB_EXPLORE', [{ id: 'r', type: 'results', hidden: true }]).issues[0]!.message).toMatch(/hidden/);
    expect(validateBlocks('WEB_EXPLORE', [{ id: 'r', type: 'results', visibility: { sides: ['VISITOR'] } }]).issues[0]!.message).toMatch(/targeting/);
    expect(validateBlocks('WEB_EXPLORE', [{ id: 'e', type: 'explore_search', hidden: true }, { id: 'r', type: 'results' }]).issues).toEqual([]);
  });
});
