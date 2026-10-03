import type { Request } from 'express';
import type { LayoutSurface, Prisma } from '../../shared/database';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { findMediaByIds, mediaIdsIn, ratioMatches, specFor } from '../media';
import { prismaLayoutsRepository as repository } from './prisma-layouts.repository';
import type { LayoutVersion, VersionKey } from './layouts.repository';
import {
  LAYOUT_SURFACES,
  SURFACE_LABEL,
  defaultBlocks,
  pageMetaSchema,
  validateBlocks,
  type Block,
  type BlockIssue,
  type BlockScope,
  type PageMeta,
} from './block-registry';
import { forgetSurface } from './resolve.cache';

/**
 * LM-1: the layout desk — draft, preview, publish, history, restore.
 *
 * The rules are `content`'s, because they were right: one row per version,
 * numbers only go up, a version is a draft until it is published, only the
 * draft changes, publishing retires whatever was live. A layout differs in
 * one way — a surface has at most one draft at a time, because the desk
 * edits "the next version of this screen", not a pile of alternatives — and
 * a restore does not republish the old row: it publishes a copy of its
 * blocks as the newest version, so the history reads in the order things
 * happened.
 *
 * PB-1 (27 Sep 2026): the same desk serves a custom Studio page. Every
 * function takes a `VersionRef` — a surface, or `{ pageId }` for a page —
 * and the rules above hold per key. A page's blocks are checked in the
 * `CUSTOM` scope (content blocks only); a version may carry `meta` (PB-4:
 * the page's SEO), versioned with the blocks.
 */

type Actor = { userId: string; req?: Request | undefined };

export type { VersionKey };

/** A surface by name (every existing call site), or a key — a surface or a custom page. */
export type VersionRef = LayoutSurface | VersionKey;

export const keyOf = (ref: VersionRef): VersionKey => (typeof ref === 'string' ? { surface: ref } : ref);
const scopeOf = (key: VersionKey): BlockScope => ('surface' in key ? key.surface : 'CUSTOM');
const nameOf = (key: VersionKey): string => ('surface' in key ? key.surface : `page ${key.pageId}`);
const keyMeta = (key: VersionKey): Record<string, string> => ('surface' in key ? { surface: key.surface } : { pageId: key.pageId });
/** The cache prefix a key's public answers sit under (resolve.cache.ts). */
export const cachePrefixOf = (key: VersionKey): string => ('surface' in key ? key.surface : `page:${key.pageId}`);
const forget = (key: VersionKey) => forgetSurface(cachePrefixOf(key));

export type LayoutVersionView = {
  id: string;
  number: number;
  status: LayoutVersion['status'];
  blocks: Block[];
  meta: PageMeta | null;
  changeNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
  publishedBy: { id: string; name: string } | null;
};

export const blocksOf = (row: Pick<LayoutVersion, 'blocks'>): Block[] => (Array.isArray(row.blocks) ? (row.blocks as unknown as Block[]) : []);

/** A version's SEO as stored — `null` on a row written before PB-4 or with none. */
export const metaOf = (row: Pick<LayoutVersion, 'meta'> | null | undefined): PageMeta | null => {
  const meta = row?.meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length > 0 ? (meta as PageMeta) : null;
};

async function views(rows: LayoutVersion[]): Promise<LayoutVersionView[]> {
  const names = await repository.userNames([...new Set(rows.map((row) => row.publishedById).filter((id): id is string => !!id))]);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    blocks: blocksOf(row),
    meta: metaOf(row),
    changeNote: row.changeNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    retiredAt: row.retiredAt,
    publishedBy: row.publishedById ? { id: row.publishedById, name: names.get(row.publishedById) ?? row.publishedById } : null,
  }));
}

async function viewOf(row: LayoutVersion | null): Promise<LayoutVersionView | null> {
  return row ? (await views([row]))[0]! : null;
}

/** `:surface` from a path — `APP_ADVERTISER_HOME`, or `app-advertiser-home` from a hand-typed URL. */
export function parseSurface(value: unknown): LayoutSurface {
  const surface = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/-/g, '_');
  if (!(LAYOUT_SURFACES as readonly string[]).includes(surface)) {
    throw new ApiError(404, 'NOT_FOUND', `No such layout surface — one of ${LAYOUT_SURFACES.join(', ')}`);
  }
  return surface as LayoutSurface;
}

/* ── Reads ─────────────────────────────────────────────────────────── */

export type SurfaceSummary = {
  surface: LayoutSurface;
  label: string;
  live: { number: number; publishedAt: Date | null } | null;
  draft: { number: number; updatedAt: Date } | null;
};

/** `GET /layouts` — every surface, what is live and whether a draft is waiting. */
export async function listSurfaces(): Promise<SurfaceSummary[]> {
  const rows = await repository.currentRows();
  return LAYOUT_SURFACES.map((surface) => {
    const live = rows.filter((row) => row.surface === surface && row.status === 'PUBLISHED').sort((a, b) => b.number - a.number)[0];
    const draft = rows.filter((row) => row.surface === surface && row.status === 'DRAFT').sort((a, b) => b.number - a.number)[0];
    return {
      surface,
      label: SURFACE_LABEL[surface],
      live: live ? { number: live.number, publishedAt: live.publishedAt } : null,
      draft: draft ? { number: draft.number, updatedAt: draft.updatedAt } : null,
    };
  });
}

/** `GET /layouts/:surface` — the live version, the draft and the defaults beside them. */
export async function getSurface(surface: LayoutSurface) {
  const { live, draft } = await getVersions(surface);
  return { surface, label: SURFACE_LABEL[surface], live, draft, defaults: defaultBlocks(surface) };
}

/** PB-1: the live version and the draft of any key — a site page's desk view reads this. */
export async function getVersions(ref: VersionRef): Promise<{ live: LayoutVersionView | null; draft: LayoutVersionView | null }> {
  const key = keyOf(ref);
  const [live, draft] = await Promise.all([repository.live(key), repository.draft(key)]);
  return { live: await viewOf(live), draft: await viewOf(draft) };
}

export async function listVersions(ref: VersionRef): Promise<LayoutVersionView[]> {
  return views(await repository.versions(keyOf(ref)));
}

/* ── Validation ────────────────────────────────────────────────────── */

const MEDIA_SHAPE: Record<string, string> = { WIDE: 'PROMO_WIDE', SQUARE: 'PROMO_SQUARE' };

const validationError = (all: BlockIssue[]) =>
  new ApiError(400, 'VALIDATION_ERROR', all.length === 1 ? all[0]!.message : `${all.length} problems with these blocks — the first: ${all[0]!.message}`, {
    issues: all,
  });

type MediaCheck = (mediaId: string, path: string, specKeys: string | null, issue: (message: string) => void) => void;

/**
 * One picture against the library: it exists, is not archived, has alt text
 * (read aloud and shown when the image cannot be — required before a block
 * may use it), and is the shape its place draws, within 1% — any of the
 * comma-separated specs when a place takes more than one shape.
 */
function mediaChecker(found: Map<string, Awaited<ReturnType<typeof findMediaByIds>>[number]>): MediaCheck {
  return (mediaId, _path, specKeys, issue) => {
    const asset = found.get(mediaId);
    if (!asset) return issue(`No picture "${mediaId}" in the library`);
    if (asset.archivedAt) return issue(`"${asset.title ?? mediaId}" is archived — restore it or pick another`);
    if (!asset.altText?.trim()) return issue(`"${asset.title ?? mediaId}" has no alt text — add it in the library first`);
    const targets = (specKeys ?? '')
      .split(',')
      .map((key) => specFor(key.trim()))
      .filter((spec): spec is NonNullable<typeof spec> => !!spec);
    if (targets.length && asset.width && asset.height && !targets.some((target) => ratioMatches(asset.width!, asset.height!, target))) {
      const wanted = targets.map((target) => `${target.label} (${target.width}×${target.height})`).join(' or ');
      issue(`"${asset.title ?? mediaId}" is ${asset.width}×${asset.height}; this place draws ${wanted}`);
    }
  };
}

/**
 * The checks that need the library, for every picture a block names: a
 * banner's aspect, a tile's square, a hero's wide, a column's tile or
 * square; a plain picture block takes any shape.
 */
async function mediaIssues(blocks: Block[]): Promise<BlockIssue[]> {
  const wanted = mediaIdsIn(blocks.map((block) => block.props));
  if (wanted.size === 0) return [];
  const check = mediaChecker(new Map((await findMediaByIds([...wanted])).map((asset) => [asset.id, asset])));
  const issues: BlockIssue[] = [];
  blocks.forEach((block, index) => {
    const at = (mediaId: string, path: string, specKeys: string | null) =>
      check(mediaId, path, specKeys, (message) => issues.push({ index, blockId: block.id, type: block.type, path, message }));
    const props = block.props as Record<string, unknown>;
    if (block.type === 'promo_banner' && typeof props['mediaId'] === 'string') {
      at(props['mediaId'], 'props.mediaId', MEDIA_SHAPE[String(props['aspect'])] ?? null);
    } else if (block.type === 'tile_grid' && Array.isArray(props['tiles'])) {
      (props['tiles'] as { mediaId?: unknown }[]).forEach((tile, i) => {
        if (typeof tile.mediaId === 'string') at(tile.mediaId, `props.tiles.${i}.mediaId`, 'TILE');
      });
    } else if (block.type === 'hero' && typeof props['mediaId'] === 'string') {
      at(props['mediaId'], 'props.mediaId', 'PROMO_WIDE');
    } else if (block.type === 'columns' && Array.isArray(props['columns'])) {
      (props['columns'] as { mediaId?: unknown }[]).forEach((column, i) => {
        if (typeof column.mediaId === 'string') at(column.mediaId, `props.columns.${i}.mediaId`, 'TILE,PROMO_SQUARE');
      });
    } else if (block.type === 'image' && typeof props['mediaId'] === 'string') {
      at(props['mediaId'], 'props.mediaId', null);
    } else {
      for (const mediaId of mediaIdsIn(props)) at(mediaId, 'props', null);
    }
  });
  return issues;
}

/** The blocks, clean, or a 400 naming every problem at once. */
export async function assertValidBlocks(scope: BlockScope, raw: unknown): Promise<Block[]> {
  const { blocks, issues } = validateBlocks(scope, raw);
  const all = issues.length ? issues : await mediaIssues(blocks);
  if (all.length) throw validationError(all);
  return blocks;
}

/**
 * PB-4: the SEO a version carries, clean, or a 400 in the blocks' issue
 * shape (`path: meta.<field>`, index -1) so the desk shows it in one list.
 * Empty strings and nulls fall away; an empty document is `null`.
 */
export async function assertValidMeta(raw: unknown): Promise<PageMeta | null> {
  if (raw === null || raw === undefined) return null;
  const parsed = pageMetaSchema.safeParse(raw);
  const issue = (path: string, message: string): BlockIssue => ({ index: -1, blockId: null, type: null, path, message });
  if (!parsed.success) throw validationError(parsed.error.issues.map((problem) => issue(['meta', ...problem.path.map(String)].join('.'), problem.message)));
  const meta: PageMeta = {};
  if (parsed.data.seoTitle) meta.seoTitle = parsed.data.seoTitle;
  if (parsed.data.seoDescription) meta.seoDescription = parsed.data.seoDescription;
  if (parsed.data.seoImageMediaId) meta.seoImageMediaId = parsed.data.seoImageMediaId;
  if (parsed.data.noindex) meta.noindex = true;
  if (meta.seoImageMediaId) {
    const check = mediaChecker(new Map((await findMediaByIds([meta.seoImageMediaId])).map((asset) => [asset.id, asset])));
    const issues: BlockIssue[] = [];
    check(meta.seoImageMediaId, 'meta.seoImageMediaId', null, (message) => issues.push(issue('meta.seoImageMediaId', message)));
    if (issues.length) throw validationError(issues);
  }
  return Object.keys(meta).length ? meta : null;
}

/* ── Writes ────────────────────────────────────────────────────────── */

const json = (value: Block[] | PageMeta) => value as unknown as Prisma.InputJsonValue;
const note = (value: string | null | undefined) => value?.trim() || null;

export type DraftInput = { blocks: unknown; meta?: unknown; changeNote?: string | null | undefined };

/**
 * `PUT /layouts/:surface/draft`, `PUT /site/pages/:key/draft` — the next
 * version of this screen or page, created or replaced. `meta` left out keeps
 * the draft's; `null` clears it.
 */
export async function saveDraft(ref: VersionRef, input: DraftInput, actor: Actor): Promise<LayoutVersionView> {
  const key = keyOf(ref);
  const blocks = await assertValidBlocks(scopeOf(key), input.blocks);
  const existing = await repository.draft(key);
  const meta = input.meta === undefined ? metaOf(existing) : await assertValidMeta(input.meta);
  const row = existing
    ? await repository.updateDraft(existing.id, {
        blocks: json(blocks),
        meta: meta ? json(meta) : null,
        changeNote: input.changeNote === undefined ? existing.changeNote : note(input.changeNote),
      })
    : await repository.createDraft({
        key,
        number: (await repository.highestNumber(key)) + 1,
        blocks: json(blocks),
        meta: meta ? json(meta) : null,
        changeNote: note(input.changeNote),
        createdByUserId: actor.userId,
      });
  await logActivity(actor.userId, existing ? 'LAYOUT_DRAFT_EDITED' : 'LAYOUT_DRAFTED', {
    req: actor.req,
    targetType: 'LayoutVersion',
    targetId: row.id,
    module: 'layouts',
    metadata: { ...keyMeta(key), number: row.number, blocks: blocks.length },
  });
  return (await viewOf(row))!;
}

/** `DELETE …/draft` — the draft goes; nothing live changes. */
export async function discardDraft(ref: VersionRef, actor: Actor): Promise<void> {
  const key = keyOf(ref);
  const draft = await repository.draft(key);
  if (!draft) throw new ApiError(404, 'NOT_FOUND', `No draft waiting on ${nameOf(key)}`);
  await repository.deleteDraft(draft.id);
  await logActivity(actor.userId, 'LAYOUT_DRAFT_DISCARDED', {
    req: actor.req,
    targetType: 'LayoutVersion',
    targetId: draft.id,
    module: 'layouts',
    metadata: { ...keyMeta(key), number: draft.number },
  });
}

/** `POST …/publish` — the draft goes live; the live one retires. Checked again, since a picture may have been archived since it was saved. */
export async function publishDraft(ref: VersionRef, input: { changeNote?: string | null | undefined }, actor: Actor): Promise<LayoutVersionView> {
  const key = keyOf(ref);
  const draft = await repository.draft(key);
  if (!draft) throw new ApiError(409, 'CONFLICT', `Nothing to publish on ${nameOf(key)} — save a draft first`);
  await assertValidBlocks(scopeOf(key), draft.blocks);
  await assertValidMeta(metaOf(draft));
  const published = await repository.publishDraft(draft.id, key, actor.userId, new Date(), input.changeNote === undefined ? null : note(input.changeNote));
  forget(key);
  await logActivity(actor.userId, 'LAYOUT_PUBLISHED', {
    req: actor.req,
    targetType: 'LayoutVersion',
    targetId: published.id,
    module: 'layouts',
    metadata: { ...keyMeta(key), number: published.number, blocks: blocksOf(published).length },
  });
  return (await viewOf(published))!;
}

/** `POST …/versions/:number/restore` — an old version's blocks (and SEO), published anew as the newest version. */
export async function restoreVersion(ref: VersionRef, number: number, actor: Actor): Promise<LayoutVersionView> {
  const key = keyOf(ref);
  const source = await repository.byNumber(key, number);
  if (!source) throw new ApiError(404, 'NOT_FOUND', `${nameOf(key)} has no version ${number}`);
  if (source.status === 'DRAFT') throw new ApiError(409, 'CONFLICT', 'That version is the draft — publish it instead');
  if (source.status === 'PUBLISHED') throw new ApiError(409, 'CONFLICT', `Version ${number} is already live`);
  const blocks = await assertValidBlocks(scopeOf(key), source.blocks);
  const meta = await assertValidMeta(metaOf(source));
  const restored = await repository.publishCopy({
    key,
    number: (await repository.highestNumber(key)) + 1,
    blocks: json(blocks),
    meta: meta ? json(meta) : null,
    changeNote: `Restored from version ${number}`,
    by: actor.userId,
    at: new Date(),
  });
  forget(key);
  await logActivity(actor.userId, 'LAYOUT_RESTORED', {
    req: actor.req,
    targetType: 'LayoutVersion',
    targetId: restored.id,
    module: 'layouts',
    metadata: { ...keyMeta(key), number: restored.number, restoredFrom: number },
  });
  return (await viewOf(restored))!;
}

export type PreviewSource = { number: number; isDefault: boolean; blocks: Block[]; meta: PageMeta | null };

/** The blocks a preview resolves: the draft, a numbered version, or 0 for the defaults (a surface only; a page has none). */
export async function blocksForPreview(ref: VersionRef, version: 'draft' | number): Promise<PreviewSource> {
  const key = keyOf(ref);
  if (version === 0) {
    if (!('surface' in key)) throw new ApiError(404, 'NOT_FOUND', 'A custom page has no default layout');
    return { number: 0, isDefault: true, blocks: defaultBlocks(key.surface), meta: null };
  }
  const row = version === 'draft' ? await repository.draft(key) : await repository.byNumber(key, version);
  if (!row) throw new ApiError(404, 'NOT_FOUND', version === 'draft' ? `No draft waiting on ${nameOf(key)}` : `${nameOf(key)} has no version ${version}`);
  return { number: row.number, isDefault: false, blocks: blocksOf(row), meta: metaOf(row) };
}

/**
 * PB-1: what a preview token shows — the draft, falling back to what is
 * live; `null` when the key has neither (a surface then draws its defaults,
 * a page is a 404).
 */
export async function draftOrLive(ref: VersionRef): Promise<LayoutVersion | null> {
  const key = keyOf(ref);
  return (await repository.draft(key)) ?? (await repository.live(key));
}
