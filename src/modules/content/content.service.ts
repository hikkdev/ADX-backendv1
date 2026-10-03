import type { Request } from 'express';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { prismaContentRepository as repository } from './prisma-content.repository';
import type { ContentFilter } from './content.repository';
import {
  CATEGORY_META,
  RESERVED_SLUGS,
  SLUG_PATTERN,
  type ContentPage,
  type PagePatch,
  type PageState,
  type PublicIndexEntry,
  type PublicPage,
} from './content.types';

/**
 * CT-1: the pages ADX writes itself.
 *
 * The rules are the legal module's, because they were right there: a version
 * is a draft until it is published, only a draft's text may change,
 * publishing retires whatever was live, and version numbers only go up. Two
 * things differ, both because a page is not a policy. A page is addressed by
 * a **slug** rather than one of a fixed set of kinds, so ops add a page
 * without a deploy. And a page may be **taken down** — a help article can
 * stop being true, where a privacy policy must always answer.
 *
 * The public reads carry no token: the website is read by people who have
 * never signed in, and a help article behind a session is not help.
 */

export function pageState(page: Pick<ContentPage, 'isActive' | 'publishedAt'>): PageState {
  if (page.isActive) return 'PUBLISHED';
  return page.publishedAt ? 'RETIRED' : 'DRAFT';
}

export type PageView = ContentPage & { state: PageState };

export const view = (page: ContentPage): PageView => ({ ...page, state: pageState(page) });

const publicView = (page: ContentPage): PublicPage => ({
  slug: page.slug,
  category: page.category,
  categoryLabel: CATEGORY_META[page.category].label,
  title: page.title,
  summary: page.summary,
  body: page.body,
  tags: page.tags,
  surfaces: page.surfaces,
  seoTitle: page.seoTitle?.trim() || page.title,
  seoDescription: page.seoDescription?.trim() || page.summary,
  version: page.version,
  publishedAt: page.publishedAt,
  updatedAt: page.updatedAt,
});

/* ── Public ───────────────────────────────────────────────────────── */

/** Every published page under the filter, without bodies. */
export async function publicIndex(filter: ContentFilter): Promise<PublicIndexEntry[]> {
  return (await repository.activeAll(filter)).map((page) => {
    const { body: _body, ...entry } = publicView(page);
    return entry;
  });
}

/** One published page by its slug. A draft, a superseded version and a page taken down all answer 404. */
export async function currentPage(slug: string): Promise<PublicPage> {
  const page = await repository.active(slug);
  if (!page) throw new ApiError(404, 'NOT_FOUND', `No page is published at "${slug}"`);
  return publicView(page);
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listPages(slug?: string): Promise<PageView[]> {
  return (await repository.list(slug)).map(view);
}

export async function getPage(id: string): Promise<PageView> {
  const page = await repository.findById(id);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'Page not found');
  return view(page);
}

function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A slug is lowercase letters, digits and single hyphens — "how-it-works".');
  }
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `"${slug}" is reserved; the desk's own routes live there.`);
  }
}

export type CreateInput = {
  slug: string;
  category: ContentPage['category'];
  title: string;
  summary?: string | undefined;
  body: string;
  surfaces?: string[] | undefined;
  tags?: string[] | undefined;
  seoTitle?: string | undefined;
  seoDescription?: string | undefined;
  sortOrder?: number | undefined;
  changeNote?: string | undefined;
  publish?: boolean | undefined;
};

/**
 * A new version of a page. The slug decides which page it is a version of:
 * a slug nobody has used starts a page at version 1, a slug that exists
 * takes the next number. Text is never edited in place once published, so a
 * change to a live page is always a new version somebody has to publish.
 */
export async function createPage(input: CreateInput, actor: { userId: string; req?: Request }): Promise<PageView> {
  assertSlug(input.slug);
  const version = (await repository.highestVersion(input.slug)) + 1;
  const created = await repository.create({
    slug: input.slug,
    version,
    category: input.category,
    title: input.title,
    summary: input.summary?.trim() || null,
    body: input.body,
    surfaces: input.surfaces ?? [],
    tags: input.tags ?? [],
    seoTitle: input.seoTitle?.trim() || null,
    seoDescription: input.seoDescription?.trim() || null,
    sortOrder: input.sortOrder ?? 0,
    changeNote: input.changeNote?.trim() || null,
    createdByUserId: actor.userId,
  });
  await logActivity(actor.userId, 'CONTENT_PAGE_DRAFTED', {
    req: actor.req,
    targetType: 'ContentPage',
    targetId: created.id,
    module: 'content',
    metadata: { slug: created.slug, version: created.version },
  });
  return input.publish ? publishPage(created.id, actor) : view(created);
}

/** Only a draft may be edited; a published version is history and stays as it was read. */
export async function updatePage(id: string, patch: PagePatch, actor: { userId: string; req?: Request }): Promise<PageView> {
  const page = await repository.findById(id);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'Page not found');
  if (pageState(page) !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'This version has been published. Make a new version instead — what people read does not change under them.');
  }
  const updated = await repository.update(id, patch);
  await logActivity(actor.userId, 'CONTENT_PAGE_EDITED', {
    req: actor.req,
    targetType: 'ContentPage',
    targetId: id,
    module: 'content',
    metadata: { slug: page.slug, version: page.version, fields: Object.keys(patch) },
  });
  return view(updated);
}

/** A draft may be discarded. A version that was ever live is kept, because somebody read it. */
export async function deletePage(id: string, actor: { userId: string; req?: Request }): Promise<void> {
  const page = await repository.findById(id);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'Page not found');
  if (pageState(page) !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'A version that was published is kept. Take the page down instead.');
  }
  await repository.delete(id);
  await logActivity(actor.userId, 'CONTENT_PAGE_DISCARDED', {
    req: actor.req,
    targetType: 'ContentPage',
    targetId: id,
    module: 'content',
    metadata: { slug: page.slug, version: page.version },
  });
}

/** Makes a version live. Publishing an older version is how a page is rolled back. */
export async function publishPage(id: string, actor: { userId: string; req?: Request }): Promise<PageView> {
  const page = await repository.findById(id);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'Page not found');
  if (page.isActive) return view(page);
  if (page.surfaces.length === 0) {
    throw new ApiError(409, 'CONFLICT', 'Say where this page is read — a page on no surface reaches nobody.');
  }
  const published = await repository.publish(id, page.slug, new Date());
  await logActivity(actor.userId, 'CONTENT_PAGE_PUBLISHED', {
    req: actor.req,
    targetType: 'ContentPage',
    targetId: id,
    module: 'content',
    metadata: { slug: page.slug, version: page.version, surfaces: page.surfaces },
  });
  return view(published);
}

/** Takes the live version down. The page 404s until a version is published again. */
export async function unpublishPage(id: string, actor: { userId: string; req?: Request }): Promise<PageView> {
  const page = await repository.findById(id);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'Page not found');
  if (!page.isActive) throw new ApiError(409, 'CONFLICT', 'This version is not the live one.');
  const down = await repository.unpublish(id, new Date());
  await logActivity(actor.userId, 'CONTENT_PAGE_TAKEN_DOWN', {
    req: actor.req,
    targetType: 'ContentPage',
    targetId: id,
    module: 'content',
    metadata: { slug: page.slug, version: page.version },
  });
  return view(down);
}
