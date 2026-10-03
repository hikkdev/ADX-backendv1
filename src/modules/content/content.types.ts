import type { ContentPage, ContentPageCategory } from '../../shared/database';

export type { ContentPage, ContentPageCategory };

/**
 * CT-1 (24 Sep 2026): the pages ADX writes itself.
 *
 * `legal` owns thirteen fixed kinds — the policies every app links to, each
 * one a deliverable with its own slot. This module owns everything else a
 * page can be: a help article, a guide, a policy outside those thirteen, a
 * page the website needs. A page is addressed by its slug rather than by a
 * kind, so ops may add one without a deploy, which is the whole point.
 */

export const CONTENT_CATEGORIES = ['PAGE', 'HELP', 'GUIDE', 'POLICY', 'NEWS'] as const;

export const CATEGORY_META: Record<ContentPageCategory, { label: string; blurb: string }> = {
  PAGE: { label: 'Page', blurb: 'A standing page — How it works, For publishers, Careers' },
  HELP: { label: 'Help article', blurb: 'One answer in the help centre' },
  GUIDE: { label: 'Guide', blurb: 'A how-to with steps' },
  POLICY: { label: 'Policy', blurb: 'A policy the thirteen legal documents do not cover' },
  NEWS: { label: 'News', blurb: 'Something dated — a release note, an announcement in full' },
};

/** Where a page is meant to be read. A page with none is a draft nobody has placed yet. */
export const CONTENT_SURFACES = ['WEBSITE', 'APP_USER', 'APP_AGENT', 'CONSOLE'] as const;
export type ContentSurface = (typeof CONTENT_SURFACES)[number];

export const SURFACE_LABEL: Record<ContentSurface, string> = {
  WEBSITE: 'Website',
  APP_USER: 'User app',
  APP_AGENT: 'Agent app',
  CONSOLE: 'Admin console',
};

/**
 * What one VERSION is. A row knows only whether it was ever live and whether
 * it is live now — whether it was replaced by a newer version or the whole
 * page was taken down is a fact about the page, not about the row, so it is
 * `pageLive()` below rather than a fourth state that would often be a guess.
 */
export type PageState = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

/** Is anything live at this slug? False for a page nobody has published yet, and for one taken down. */
export function pageLive(versions: { isActive: boolean }[]): boolean {
  return versions.some((version) => version.isActive);
}

export type NewPage = {
  slug: string;
  version: number;
  category: ContentPageCategory;
  title: string;
  summary: string | null;
  body: string;
  surfaces: string[];
  tags: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  sortOrder: number;
  changeNote: string | null;
  createdByUserId: string | null;
};

/** Only a draft's text may change; the slug never does, because it is the address. */
export type PagePatch = {
  category?: ContentPageCategory;
  title?: string;
  summary?: string | null;
  body?: string;
  surfaces?: string[];
  tags?: string[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  sortOrder?: number;
  changeNote?: string | null;
};

/** One published page as a reader gets it. */
export type PublicPage = {
  slug: string;
  category: ContentPageCategory;
  categoryLabel: string;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  surfaces: string[];
  seoTitle: string;
  seoDescription: string | null;
  version: number;
  publishedAt: Date | null;
  updatedAt: Date;
};

/** The index: every published page a surface asks for, without bodies. */
export type PublicIndexEntry = Omit<PublicPage, 'body'>;

/**
 * The slug a title suggests, and the shape every slug is held to: lowercase
 * letters, digits and single hyphens. It is the page's address, so it is
 * checked rather than trusted.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugs the router would shadow: `/content/pages` is the desk's own prefix. */
export const RESERVED_SLUGS = ['pages', 'index'] as const;
