import type { LayoutSurface, Role } from '../../shared/database';
import { findDeclaration } from '../../shared/features';
import { logger } from '../../shared/logging';
import { currentContentPage } from '../content';
import { isFeatureEnabled } from '../feature-flags';
import { findMediaByIds, mediaIdsIn, mediaRef, type MediaRef } from '../media';
import { citySupport } from '../pricing';
import { prismaLayoutsRepository as repository } from './prisma-layouts.repository';
import { SIDES, defaultBlocks, isSystemType, type Block, type PageMeta, type Side } from './block-registry';
import { blocksOf, draftOrLive, metaOf } from './layouts.service';
import { cached } from './resolve.cache';

/**
 * LM-1: what a screen draws, for whoever is looking, right now.
 *
 * A layout is stored as the desk wrote it; a client is handed it resolved.
 * Blocks that are hidden, out of their schedule, or targeted at another
 * side, city or city stage are dropped. Every `mediaId` gains `media`
 * (url, size, alt text) beside it; a listing rail gains the browse `query`
 * the client passes to `GET /listings/browse`; a text block naming a
 * published page gains its `markdown`; an ad slot gains the slot and the
 * LIVE ads booked into it for today in this city, shuffled so the rotation
 * is fair. Something that cannot be drawn — a picture archived since, a
 * page taken down, a slot that is gone — drops its block rather than
 * handing the client a hole. The additions live in `props`, so a
 * `ResolvedBlock` is always `{ id, type, props }`.
 *
 * PB-1 (27 Sep 2026): the page blocks resolve here too — a hero's or a
 * column's picture, a grid's query, a form's published definition (through
 * the port the forms module registers) — and every `PAGE` target, wherever
 * it sits in a block's props, gains `href`: the page's current address, so
 * a client needs no second read to link to a Studio page.
 */

export type ResolveContext = { side: Side; cityId: string | null; stage: string | null; now: Date };

export type ResolvedBlock = { id: string; type: string; props: Record<string, unknown> };

/** PB-4: a version's SEO as a client gets it — the picture resolved, every field present. */
export type ResolvedMeta = { seoTitle: string | null; seoDescription: string | null; seoImage: MediaRef | null; noindex: boolean };

export type ResolvedLayout = { surface: LayoutSurface; version: number; isDefault: boolean; meta: ResolvedMeta; blocks: ResolvedBlock[]; preview?: true };

export type ResolvedAd = {
  adBookingId: string;
  displayId: string | null;
  media: MediaRef;
  headline: string | null;
  ctaLabel: string | null;
  targetUrl: string | null;
};

/* ── The forms port ─────────────────────────────────────────────────── */

/** What a `form` block is handed: the form's published version, as `forms` answers `GET /app/forms/:key`. */
export type ResolvedForm = { key: string; title: string; description: string | null; audience: string; version: number; definition: unknown };

export type FormResolver = (key: string) => Promise<ResolvedForm | null>;

let formResolver: FormResolver | null = null;

/**
 * PB-1: `forms` registers how a form key becomes its published view, at
 * module load, so `layouts` never imports `forms`. Until one is registered
 * every form block resolves to `null` and the client draws nothing.
 */
export function registerFormResolver(fn: FormResolver): void {
  formResolver = fn;
}

export async function resolveForm(key: string): Promise<ResolvedForm | null> {
  if (!formResolver) return null;
  try {
    return await formResolver(key);
  } catch (err) {
    logger.warn('form block unresolved; drawing nothing', { key, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Tests: forget the registered resolver. */
export function resetFormResolverForTests(): void {
  formResolver = null;
}

/* ── Who is looking ─────────────────────────────────────────────────── */

const SURFACE_SIDE: Partial<Record<LayoutSurface, Side>> = {
  APP_ADVERTISER_HOME: 'ADVERTISER',
  APP_PUBLISHER_HOME: 'PUBLISHER',
  APP_PARTNER_HOME: 'PARTNER',
};

const ROLE_SIDE: [Role, Side][] = [
  ['ADVERTISER', 'ADVERTISER'],
  ['PUBLISHER', 'PUBLISHER'],
  ['PARTNER', 'PARTNER'],
  ['AGENT_PUBLISHER', 'AGENT_FIELD'],
  ['AGENT_ADVERTISER', 'AGENT_SALES'],
];

/**
 * The side a signed-in caller is on when the client did not say: the one
 * the surface is for when the account has it (an advertiser home is read
 * as an advertiser), else the first side the account has. Signed out is
 * VISITOR; an operator with no party side reads as a visitor too. A custom
 * page (PB-1) is for no side in particular, so `surface` may be null.
 */
export function sideFor(surface: LayoutSurface | null, roles: readonly string[] | undefined, asked?: string | null): Side {
  if (asked && (SIDES as readonly string[]).includes(asked)) return asked as Side;
  if (!roles?.length) return 'VISITOR';
  const sides = ROLE_SIDE.filter(([role]) => roles.includes(role)).map(([, side]) => side);
  const natural = surface ? SURFACE_SIDE[surface] : undefined;
  if (natural && sides.includes(natural)) return natural;
  if (surface === 'AGENT_HOME') return sides.find((side) => side.startsWith('AGENT_')) ?? sides[0] ?? 'VISITOR';
  return sides[0] ?? 'VISITOR';
}

/**
 * The place: a catalogue id, or a city typed by name (resolved the way the
 * browse resolves it), and the city's stage unless the client names one.
 */
export async function placeFor(input: { cityId?: string | undefined; city?: string | undefined; stage?: string | undefined }): Promise<{ cityId: string | null; stage: string | null }> {
  let cityId = input.cityId ?? null;
  let stage = input.stage ?? null;
  if (!cityId && input.city) {
    const support = await citySupport(input.city);
    cityId = support.city?.id ?? null;
    stage = stage ?? support.stage ?? null;
  }
  if (cityId && !stage) stage = await repository.cityStage(cityId);
  return { cityId, stage };
}

/* ── Filtering ─────────────────────────────────────────────────────── */

/** Whether a block is shown to this caller now. A targeted block with nothing to match against is not. */
export function isVisible(block: Block, ctx: ResolveContext): boolean {
  if (block.hidden) return false;
  const at = ctx.now.getTime();
  if (block.schedule?.startsAt && Date.parse(block.schedule.startsAt) > at) return false;
  if (block.schedule?.endsAt && Date.parse(block.schedule.endsAt) <= at) return false;
  const { sides, cityIds, stages } = block.visibility ?? {};
  if (sides?.length && !sides.includes(ctx.side)) return false;
  if (cityIds?.length && (!ctx.cityId || !cityIds.includes(ctx.cityId))) return false;
  if (stages?.length && (!ctx.stage || !(stages as string[]).includes(ctx.stage))) return false;
  return true;
}

/* ── The additions ─────────────────────────────────────────────────── */

export type RailQuery = {
  sort?: 'RATING' | 'NEWEST';
  category?: string;
  venueTypeId?: string;
  publisherId?: string;
  near?: true;
  ids?: string[];
  pageSize: number;
};

/** The browse query a listing rail (or grid) stands for. `near` asks the client to add its own lat/lng. */
export function railQuery(props: Record<string, unknown>): RailQuery {
  const pageSize = Number(props['count']) || 6;
  const value = typeof props['value'] === 'string' ? props['value'] : undefined;
  switch (props['source']) {
    case 'RATING':
      return { sort: 'RATING', pageSize };
    case 'NEWEST':
      return { sort: 'NEWEST', pageSize };
    case 'NEAR_YOU':
      return { near: true, pageSize };
    case 'CATEGORY':
      return value ? { category: value, pageSize } : { pageSize };
    case 'VENUE':
      return value ? { venueTypeId: value, pageSize } : { pageSize };
    case 'PUBLISHER':
      return value ? { publisherId: value, pageSize } : { pageSize };
    case 'CURATED':
      return { ids: (Array.isArray(props['listingIds']) ? (props['listingIds'] as string[]) : []).slice(0, pageSize), pageSize };
    default:
      return { pageSize };
  }
}

const isPageTarget = (value: Record<string, unknown>): value is { kind: 'PAGE'; value: string } => value['kind'] === 'PAGE' && typeof value['value'] === 'string';

/** Every Studio page a block's props link to, at any depth — a hero's buttons, a column's target, a button row. */
export function pageKeysIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) pageKeysIn(item, into);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isPageTarget(record)) into.add(record.value);
    for (const inner of Object.values(record)) pageKeysIn(inner, into);
  }
  return into;
}

/** The same props with `href` beside every `PAGE` target whose page is live; `value` stays, and a target with no live page keeps only that. */
export function withPageHrefs<T>(value: T, paths: ReadonlyMap<string, string>): T {
  if (Array.isArray(value)) return value.map((item) => withPageHrefs(item, paths)) as unknown as T;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) out[key] = withPageHrefs(inner, paths);
    if (isPageTarget(record)) {
      const href = paths.get(record.value);
      if (href) out['href'] = href;
    }
    return out as T;
  }
  return value;
}

/** Sold display ads — the promotions builder's switch. Undeclared yet means nothing to switch off. */
async function adsSwitchedOn(): Promise<boolean> {
  if (!findDeclaration('promotions.ads')) return true;
  try {
    return await isFeatureEnabled('promotions.ads');
  } catch (err) {
    logger.warn('promotions.ads flag unreadable; drawing no ads', { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

const dayOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

async function publishedMarkdown(slug: string): Promise<string | null> {
  try {
    return (await currentContentPage(slug)).body;
  } catch {
    return null;
  }
}

/** A version's SEO for a client: the picture looked up, absent fields null. */
export async function resolveMeta(meta: PageMeta | null | undefined): Promise<ResolvedMeta> {
  let seoImage: MediaRef | null = null;
  if (meta?.seoImageMediaId) {
    const [asset] = await findMediaByIds([meta.seoImageMediaId]);
    if (asset && !asset.archivedAt) seoImage = mediaRef(asset);
  }
  return { seoTitle: meta?.seoTitle ?? null, seoDescription: meta?.seoDescription ?? null, seoImage, noindex: meta?.noindex === true };
}

/**
 * Resolves blocks for one caller. Not cached — the public read caches what
 * this answers; the preview calls it straight.
 */
export async function resolveBlocks(blocks: Block[], ctx: ResolveContext): Promise<ResolvedBlock[]> {
  const shown = blocks.filter((block) => isVisible(block, ctx));

  const media = new Map<string, MediaRef>();
  const remember = async (ids: Iterable<string>) => {
    const missing = [...new Set(ids)].filter((id) => !media.has(id));
    if (!missing.length) return;
    for (const asset of await findMediaByIds(missing)) if (!asset.archivedAt) media.set(asset.id, mediaRef(asset));
  };
  await remember(mediaIdsIn(shown.map((block) => block.props)));

  const pageKeys = pageKeysIn(shown.map((block) => block.props));
  const pagePaths = pageKeys.size ? await repository.pagePaths([...pageKeys]) : new Map<string, string>();

  const adsOn = shown.some((block) => block.type === 'ad_slot') ? await adsSwitchedOn() : false;
  const day = dayOf(ctx.now);

  const resolved: ResolvedBlock[] = [];
  for (const block of shown) {
    const props = { ...(block.props as Record<string, unknown>) };
    const push = (out: Record<string, unknown>) => resolved.push({ id: block.id, type: block.type, props: withPageHrefs(out, pagePaths) });

    if (isSystemType(block.type)) {
      push(props);
      continue;
    }
    switch (block.type) {
      case 'promo_banner': {
        const ref = media.get(String(props['mediaId']));
        if (!ref) continue;
        push({ ...props, media: ref });
        break;
      }
      case 'tile_grid': {
        const tiles = (Array.isArray(props['tiles']) ? (props['tiles'] as Record<string, unknown>[]) : [])
          .map((tile) => ({ ...tile, media: media.get(String(tile['mediaId'])) }))
          .filter((tile) => tile.media);
        if (!tiles.length) continue;
        push({ ...props, tiles });
        break;
      }
      case 'listing_rail':
      case 'listing_grid':
        push({ ...props, query: railQuery(props) });
        break;
      case 'rich_text': {
        if (typeof props['contentSlug'] === 'string') {
          const markdown = await publishedMarkdown(props['contentSlug']);
          if (markdown === null) continue;
          push({ ...props, markdown });
        } else if (typeof props['markdown'] === 'string' && props['markdown'].trim()) {
          push(props);
        }
        break;
      }
      case 'ad_slot': {
        const slot = await repository.slotByKey(String(props['slotKey']));
        if (!slot || !slot.isActive) continue;
        let ads: ResolvedAd[] = [];
        if (adsOn) {
          const rows = await repository.liveAds(slot.id, day, ctx.cityId);
          await remember(rows.map((row) => row.mediaId).filter((id): id is string => !!id));
          ads = rows.flatMap((row) => {
            const ref = row.mediaId ? media.get(row.mediaId) : undefined;
            return ref
              ? [{ adBookingId: row.id, displayId: row.displayId, media: ref, headline: row.headline, ctaLabel: row.ctaLabel, targetUrl: row.targetUrl }]
              : [];
          });
        }
        push({ ...props, slot: { key: slot.key, label: slot.label, spec: slot.spec }, ads });
        break;
      }
      // PB-1: the page blocks.
      case 'hero': {
        // The picture is optional: a hero whose picture has gone since still draws, without it.
        const ref = typeof props['mediaId'] === 'string' ? media.get(props['mediaId']) : undefined;
        if (ref) push({ ...props, media: ref });
        else {
          const { mediaId: _gone, ...rest } = props;
          push(rest);
        }
        break;
      }
      case 'columns': {
        const columns = (Array.isArray(props['columns']) ? (props['columns'] as Record<string, unknown>[]) : []).map((column) => {
          const ref = typeof column['mediaId'] === 'string' ? media.get(column['mediaId']) : undefined;
          if (ref) return { ...column, media: ref };
          const { mediaId: _gone, ...rest } = column;
          return rest;
        });
        push({ ...props, columns });
        break;
      }
      case 'image': {
        const ref = media.get(String(props['mediaId']));
        if (!ref) continue;
        push({ ...props, media: ref });
        break;
      }
      case 'form':
        push({ ...props, form: await resolveForm(String(props['formKey'])) });
        break;
      case 'cta_strip':
      case 'video':
      case 'faq':
      case 'steps':
      case 'stats':
      case 'divider':
      case 'button_row':
      case 'category_tiles':
        push(props);
        break;
      default:
        // A type this build does not know is not handed to a client that may not know it either.
        break;
    }
  }
  return resolved;
}

/** A fair rotation: every read deals the slot's live ads in a fresh order. */
export function shuffleAds(blocks: ResolvedBlock[], random: () => number = Math.random): ResolvedBlock[] {
  return blocks.map((block) => {
    const ads = block.props['ads'];
    if (block.type !== 'ad_slot' || !Array.isArray(ads) || ads.length < 2) return block;
    const dealt = [...ads];
    for (let i = dealt.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [dealt[i], dealt[j]] = [dealt[j], dealt[i]];
    }
    return { ...block, props: { ...block.props, ads: dealt } };
  });
}

type LiveLayout = { number: number; blocks: Block[]; meta: PageMeta | null } | null;

/** The cache key of one resolved answer: the key's prefix, the version, and the caller's side, city, stage and UTC day. */
export const resolveCacheKey = (prefix: string, version: number, ctx: ResolveContext): string =>
  [prefix, `v${version}`, ctx.side, ctx.cityId ?? '-', ctx.stage ?? '-', dayOf(ctx.now).toISOString().slice(0, 10)].join('|');

/**
 * `GET /app/layouts/:surface` — the published layout, or the defaults as
 * version 0, resolved for this caller. Cached sixty seconds per surface,
 * version, side, city, stage and day; the ads are dealt fresh on every read.
 *
 * PB-1: with `preview` (a valid preview token naming this surface) the
 * draft is answered, falling back to what is live — uncached, since a
 * draft changes as the desk types.
 */
export async function resolvePublic(surface: LayoutSurface, ctx: ResolveContext, preview = false): Promise<ResolvedLayout> {
  if (preview) {
    const row = await draftOrLive(surface);
    const blocks = row ? blocksOf(row) : defaultBlocks(surface);
    const [resolved, meta] = await Promise.all([resolveBlocks(blocks, ctx), resolveMeta(metaOf(row))]);
    return { surface, version: row?.number ?? 0, isDefault: !row, meta, blocks: shuffleAds(resolved), preview: true };
  }
  const live = await cached<LiveLayout>(`${surface}|live`, async () => {
    const row = await repository.live({ surface });
    return row ? { number: row.number, blocks: blocksOf(row), meta: metaOf(row) } : null;
  });
  const version = live?.number ?? 0;
  const blocks = live?.blocks ?? defaultBlocks(surface);
  const key = resolveCacheKey(surface, version, ctx);
  const answer = await cached(key, async () => {
    const [resolved, meta] = await Promise.all([resolveBlocks(blocks, ctx), resolveMeta(live?.meta)]);
    return { resolved, meta };
  });
  return { surface, version, isDefault: !live, meta: answer.meta, blocks: shuffleAds(answer.resolved) };
}
