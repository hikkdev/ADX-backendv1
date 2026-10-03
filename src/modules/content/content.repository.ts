import type { ContentPage, ContentPageCategory, NewPage, PagePatch } from './content.types';

export interface ContentFilter {
  surface?: string | undefined;
  category?: ContentPageCategory | undefined;
  tag?: string | undefined;
}

export interface ContentRepository {
  /** Every version of every page, or of one slug — the desk's list. */
  list(slug?: string): Promise<ContentPage[]>;
  findById(id: string): Promise<ContentPage | null>;
  /** The live version of a slug, or null while nothing is published or it was taken down. */
  active(slug: string): Promise<ContentPage | null>;
  /** Every live page under a filter, for an index. */
  activeAll(filter: ContentFilter): Promise<ContentPage[]>;
  highestVersion(slug: string): Promise<number>;
  create(data: NewPage): Promise<ContentPage>;
  update(id: string, patch: PagePatch): Promise<ContentPage>;
  delete(id: string): Promise<void>;
  /** Makes one version live and retires whichever was, in one transaction. */
  publish(id: string, slug: string, at: Date): Promise<ContentPage>;
  /** Takes the live version down without deleting it. */
  unpublish(id: string, at: Date): Promise<ContentPage>;
}
