import type { AdBooking, AdSlot, LayoutSurface, LayoutVersion, Prisma } from '../../shared/database';

export type { LayoutVersion };

export type SlotRow = Pick<AdSlot, 'id' | 'key' | 'label' | 'spec' | 'isActive'>;
export type LiveAdRow = Pick<AdBooking, 'id' | 'displayId' | 'mediaId' | 'headline' | 'ctaLabel' | 'targetUrl' | 'cityIds'>;

/**
 * PB-1 (27 Sep 2026): what a run of versions belongs to — a surface (a
 * website page the code draws, or an app home) or a custom Studio page by
 * its row id. Exactly one of the two, as the DB check on `LayoutVersion`
 * says.
 */
export type VersionKey = { surface: LayoutSurface } | { pageId: string };

/** A version's JSON columns as the service hands them down: `null` clears `meta`. */
export type VersionJson = { blocks: Prisma.InputJsonValue; meta: Prisma.InputJsonValue | null };

export interface LayoutsRepository {
  /** The PUBLISHED and DRAFT rows of every surface and page — the desk's overview. */
  currentRows(): Promise<LayoutVersion[]>;
  live(key: VersionKey): Promise<LayoutVersion | null>;
  draft(key: VersionKey): Promise<LayoutVersion | null>;
  byNumber(key: VersionKey, number: number): Promise<LayoutVersion | null>;
  versions(key: VersionKey): Promise<LayoutVersion[]>;
  highestNumber(key: VersionKey): Promise<number>;
  createDraft(data: VersionJson & { key: VersionKey; number: number; changeNote: string | null; createdByUserId: string }): Promise<LayoutVersion>;
  updateDraft(id: string, data: VersionJson & { changeNote: string | null }): Promise<LayoutVersion>;
  deleteDraft(id: string): Promise<void>;
  /** Makes the draft live and retires whatever was, in one transaction. */
  publishDraft(id: string, key: VersionKey, by: string, at: Date, changeNote: string | null): Promise<LayoutVersion>;
  /** A new PUBLISHED version with these blocks (a restore), retiring the live one, in one transaction. */
  publishCopy(data: VersionJson & { key: VersionKey; number: number; changeNote: string | null; by: string; at: Date }): Promise<LayoutVersion>;
  userNames(ids: string[]): Promise<Map<string, string>>;
  /** A catalogued city's stage, by id. */
  cityStage(cityId: string): Promise<string | null>;
  slotByKey(key: string): Promise<SlotRow | null>;
  /** LIVE bookings in a slot running on `day` (00:00Z), shown in `cityId` or everywhere. */
  liveAds(slotId: string, day: Date, cityId: string | null): Promise<LiveAdRow[]>;
  /**
   * PB-1: the current address of each live page named, by key — a system
   * page always, a custom page once something is published on it — so a
   * `PAGE` target resolves to an `href` in one read. Archived pages are not
   * answered.
   */
  pagePaths(keys: string[]): Promise<Map<string, string>>;
}
