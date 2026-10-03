import type { LayoutVersion, SitePage, SitePageChannel, SiteRedirect, SiteRedirectReason } from '../../shared/database';

export type { SitePage, SitePageChannel, SiteRedirect, SiteRedirectReason };

export type PageRow = SitePage & { redirectCount: number };
export type RedirectRow = SiteRedirect & { page: { key: string; title: string } | null };

/** The PUBLISHED and DRAFT rows of every surface and page — enough to say what is live and what waits. */
export type VersionSummary = Pick<LayoutVersion, 'surface' | 'pageId' | 'number' | 'status' | 'meta' | 'publishedAt' | 'updatedAt'>;

export type NewPage = { key: string; title: string; path: string; channels: SitePageChannel[]; createdByUserId: string };
export type PagePatch = { title?: string; channels?: SitePageChannel[]; archivedAt?: Date | null };
export type NewRedirect = { fromPath: string; toPath: string; pageId: string | null; permanent: boolean; reason: SiteRedirectReason; createdByUserId: string | null };

export interface SitePagesRepository {
  /** Every page, archived ones too, with how many redirects point at it. */
  listPages(): Promise<PageRow[]>;
  findByKey(key: string): Promise<SitePage | null>;
  /** The page at an address, archived or not — an address is taken either way. */
  pageAtPath(path: string): Promise<SitePage | null>;
  createPage(data: NewPage): Promise<SitePage>;
  updatePage(id: string, patch: PagePatch): Promise<SitePage>;
  currentVersions(): Promise<VersionSummary[]>;
  listRedirects(): Promise<RedirectRow[]>;
  findRedirect(id: string): Promise<SiteRedirect | null>;
  redirectFrom(fromPath: string): Promise<SiteRedirect | null>;
  createRedirect(data: NewRedirect): Promise<SiteRedirect>;
  deleteRedirect(id: string): Promise<void>;
  /**
   * An address change, in one transaction: the redirect at the new address
   * (the page's own, when it is moving back) goes; every redirect that
   * pointed at the old address points at the new one (no chains); the page
   * moves; a permanent redirect from the old address is written.
   */
  changeAddress(input: { pageId: string; oldPath: string; newPath: string; by: string; dropRedirectId: string | null }): Promise<{ page: SitePage; retargeted: number }>;
}
