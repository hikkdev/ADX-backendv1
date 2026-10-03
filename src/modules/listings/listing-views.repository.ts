/**
 * LD-1 (3 Oct 2026): spot-page views — see `listing-views.service.ts`.
 */

export const LISTING_VIEW_SOURCES = ['WEB', 'APP'] as const;
export type ListingViewSource = (typeof LISTING_VIEW_SOURCES)[number];

/** What the count needs of the spot: whether it is live, and whose it is (never counted on their own page). */
export type ViewedListing = {
  id: string;
  /** The publisher's login, and the login of the agent who manages the publisher. */
  publisherUserId: string | null;
  publisherAgentUserId: string | null;
  /** The login of the agent who keyed the spot in. */
  agentUserId: string | null;
};

export type ViewToRecord = {
  listingId: string;
  /** The Indian day, `YYYY-MM-DD`. */
  day: string;
  /** The keyed hash of the visitor — never an address or an id. */
  visitorHash: string;
  source: ListingViewSource;
  now: Date;
  /** A repeat by the same visitor inside this many milliseconds is the same view (a page that fired twice). */
  repeatWithinMs: number;
};

export type RecordedView = { counted: boolean; uniqueVisitor: boolean };

export interface ListingViewsRepository {
  /** An ACTIVE listing by its id or its display id (`LST-…`), with the logins it belongs to; null otherwise. */
  findLiveForView(idOrDisplayId: string): Promise<ViewedListing | null>;
  /**
   * One statement: the visitor's key for the day (a repeat inside the
   * window counts nothing), the day's row (+1 view, +1 visitor when the key
   * is new), and on the day's first view the listing's older keys removed.
   */
  record(view: ViewToRecord): Promise<RecordedView>;
}
