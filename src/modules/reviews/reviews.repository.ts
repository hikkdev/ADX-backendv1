import type { Review, ReviewAnchorKind, ReviewStatus, ReviewSubjectType } from '../../shared/database';
import type { ListReviewsQuery } from './reviews.schema';

export type ReviewRow = Review;

/** What a review is written from. Status is the default, PUBLISHED. */
export type NewReview = {
  subjectType: ReviewSubjectType;
  subjectId: string;
  authorUserId: string;
  authorPublisherId: string | null;
  authorAdvertiserId: string | null;
  anchorKind: ReviewAnchorKind;
  anchorId: string;
  rating: number;
  note: string | null;
};

/**
 * The published reviews' average and count for one subject — what the
 * denormalised columns on Listing and AgentRating are written from. The
 * average is a decimal string with two places, or null when there are none.
 */
export type ReviewAggregate = { avg: string | null; count: number };

export interface ReviewsRepository {
  findById(id: string): Promise<ReviewRow | null>;
  /** The one review this transaction earned the right to write, if written. */
  findByAnchor(anchorKind: ReviewAnchorKind, anchorId: string, subjectType: ReviewSubjectType): Promise<ReviewRow | null>;
  create(data: NewReview): Promise<ReviewRow>;
  /** Q112: a publisher rates an agent once, ever — the partial unique in the migration. */
  publisherHasRatedAgent(publisherId: string, agentId: string): Promise<boolean>;
  /** PUBLISHED only: a hidden review leaves the average the moment it is hidden. */
  aggregate(subjectType: ReviewSubjectType, subjectId: string): Promise<ReviewAggregate>;
  /** The public page: PUBLISHED, newest first. E7-2: the agent's own list adds a note search and the sort. */
  listPublished(
    subjectType: ReviewSubjectType,
    subjectId: string,
    page: number,
    pageSize: number,
    options?: { q?: string | undefined; sort?: 'NEWEST' | 'OLDEST' | undefined },
  ): Promise<{ items: ReviewRow[]; total: number }>;
  /** The desk: every status, with the histogram counted without the status facet. */
  listForAdmin(query: ListReviewsQuery): Promise<{ items: ReviewRow[]; total: number; counts: Record<string, number> }>;
  setStatus(id: string, patch: { status: ReviewStatus; hiddenReason: string | null; hiddenById: string | null }): Promise<ReviewRow>;
  /** The agent's ledger feed: PUBLISHED reviews of one agent since `from`, newest first, ten at most. */
  recentForAgent(agentId: string, from: Date): Promise<ReviewRow[]>;
  /**
   * E7-2: the names behind `authorPublisherId`, for the ledger row. A read-only
   * look at `Publisher.name` — this module owns no publisher, and `publishers`
   * exports no name lookup; the way `announcements` reads its audience.
   */
  publisherNames(publisherIds: string[]): Promise<Map<string, string>>;
  /** E7-2: the reviews written on these anchors, any status — a hidden review still means the spot was reviewed. */
  findByAnchors(anchorKind: ReviewAnchorKind, anchorIds: string[], subjectType: ReviewSubjectType): Promise<ReviewRow[]>;
}
