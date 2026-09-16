import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { toListPage, type ListPage } from '../../shared/pagination';
import { setAgentReviewSnapshot } from '../agents';
import { assertMayAct, findCampaignSpotForReview, type CampaignActor } from '../campaigns';
import { getListingWithPublisher, setListingRatingSnapshot } from '../listings';
import { createNotification } from '../notifications';
import { getOrderSummary } from '../orders';
import { prismaReviewsRepository as repository } from './prisma-reviews.repository';
import type { ReviewRow } from './reviews.repository';
import type { ListReviewsQuery, MyAgentReviewsQuery, RateInput, ReviewPageQuery } from './reviews.schema';
import type { ReviewSubjectType } from '../../shared/database';

/**
 * Reviews — Lot D (Q5/Q19/Q104/Q112/Q137).
 *
 * One table for what people say about a spot or an agent, and one rule
 * under both: every review hangs off the transaction that earned the right
 * to write it. An advertiser reviews a spot through the campaign spot that
 * ran on it, once it ran to the end; a publisher rates an agent through the
 * order the agent installed, from the on-site OTP onward. "24 reviews" is a
 * claim about 24 bookings, which is the only kind of claim worth printing.
 *
 * The stars are denormalised onto the subject — `Listing.ratingAvg` /
 * `reviewCount`, `AgentRating.reviewAvg` / `reviewCount` — recomputed from
 * this table on every write and handed to the owning module, so browse and
 * the agent rating need no join and never disagree with the rows.
 */

/* ------------------------------------------------------------------ */
/* Recomputing the stars                                               */
/* ------------------------------------------------------------------ */

/** PUBLISHED reviews only: hiding one takes it out of the average at once. */
async function recomputeSubject(subjectType: ReviewSubjectType, subjectId: string): Promise<void> {
  const { avg, count } = await repository.aggregate(subjectType, subjectId);
  if (subjectType === 'LISTING') {
    await setListingRatingSnapshot(subjectId, { ratingAvg: avg, reviewCount: count });
  } else {
    await setAgentReviewSnapshot(subjectId, { reviewAvg: avg, reviewCount: count });
  }
}

/* ------------------------------------------------------------------ */
/* A spot — Q104                                                       */
/* ------------------------------------------------------------------ */

/**
 * The campaign's advertiser reviews one of its spots.
 *
 * Only the advertiser: `assertMayAct` is the campaign's own ownership rule
 * (owner, the agent who built it, ADX), and on top of it the author has to
 * be the advertiser account the campaign belongs to — an agent sells the
 * spot and ADX runs the platform, and neither stood in front of it. Only a
 * spot that COMPLETED, because nothing else has happened to review. Once
 * per spot, which the unique on (anchorKind, anchorId, subjectType) backs.
 */
export async function reviewSpot(
  campaignId: string,
  spotId: string,
  input: RateInput,
  actor: CampaignActor,
): Promise<ReviewRow> {
  const found = await findCampaignSpotForReview(campaignId, spotId);
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'That spot is not part of this campaign');
  const { campaign, spot } = found;

  assertMayAct(campaign, actor);
  if (!actor.advertiserId || actor.advertiserId !== campaign.advertiserId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the advertiser this campaign ran for can review its spots.');
  }
  if (spot.status !== 'COMPLETED') {
    throw new ApiError(409, 'CONFLICT', 'A spot can be reviewed once its booking has run to the end.');
  }
  if (await repository.findByAnchor('CAMPAIGN_SPOT', spot.id, 'LISTING')) {
    throw new ApiError(409, 'REVIEW_EXISTS', 'This spot has already been reviewed for this campaign.');
  }

  const review = await repository.create({
    subjectType: 'LISTING',
    subjectId: spot.listingId,
    authorUserId: actor.userId,
    authorPublisherId: null,
    authorAdvertiserId: campaign.advertiserId,
    anchorKind: 'CAMPAIGN_SPOT',
    anchorId: spot.id,
    rating: input.rating,
    note: input.note ?? null,
  });

  await recomputeSubject('LISTING', spot.listingId);

  // The publisher hears about it; a review is a decision about their spot.
  // Fire-and-forget: a notification that cannot be written must not fail
  // the review, which is already on the books.
  const listing = await getListingWithPublisher(spot.listingId);
  if (listing?.publisher?.userId) {
    createNotification({
      userId: listing.publisher.userId,
      type: 'BOOKING',
      title: 'New review on your spot',
      subtitle: listing.title,
      message: `An advertiser rated "${listing.title}" ${input.rating} star${input.rating === 1 ? '' : 's'}${input.note ? `: "${input.note}"` : '.'}`,
      relatedId: spot.listingId,
      relatedType: 'LISTING',
    }).catch(() => {});
  }
  await logActivity(actor.userId, 'LISTING_REVIEWED', {
    targetType: 'Listing',
    targetId: spot.listingId,
    module: 'reviews',
    metadata: { reviewId: review.id, campaignId: campaign.id, spotId: spot.id, rating: input.rating },
  });

  return review;
}

/**
 * E7-2: the campaigns module's SpotReviewPort — which of a campaign's spots
 * carry a review, filled by bootstrap because `campaigns` cannot import
 * this module back. Any status: a spot with a hidden review was reviewed.
 */
export async function reviewIdsForCampaignSpots(spotIds: string[]): Promise<Map<string, string>> {
  const rows = await repository.findByAnchors('CAMPAIGN_SPOT', spotIds, 'LISTING');
  return new Map(rows.map((row) => [row.anchorId, row.id]));
}

/** What the listing page prints: the stars and the line, never who wrote it. */
export type PublicReview = { id: string; rating: number; note: string | null; createdAt: Date };

export async function listingReviews(listingId: string, query: ReviewPageQuery): Promise<ListPage<PublicReview>> {
  const { items, total } = await repository.listPublished('LISTING', listingId, query.page, query.pageSize);
  return toListPage(
    items.map((review) => ({ id: review.id, rating: review.rating, note: review.note, createdAt: review.createdAt })),
    total,
    {},
    query,
  );
}

/* ------------------------------------------------------------------ */
/* An agent — Q112                                                     */
/* ------------------------------------------------------------------ */

/** From the on-site OTP onward: the job is done, whether or not ops have signed it off. */
const RATEABLE_ORDER_STATUSES = ['PENDING_APPROVAL', 'COMPLETED'] as const;

export type AgentRatingEligibility = {
  askable: boolean;
  /** Why not, when not — the screen decides whether to draw the prompt at all. */
  reason: 'NO_AGENT' | 'NOT_YET' | 'ALREADY_RATED' | null;
};

/**
 * The order, its listing's publisher, and whether this caller is that
 * publisher. 403 for anyone else: the question is the publisher's alone.
 */
async function rateableOrder(orderId: string, publisherUserId: string) {
  const order = await getOrderSummary(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  const listing = await getListingWithPublisher(order.listingId);
  if (!listing?.publisher || listing.publisher.userId !== publisherUserId) {
    throw new ApiError(403, 'FORBIDDEN', 'This order is not on one of your spots.');
  }
  return { order, publisherId: listing.publisher.id };
}

async function eligibilityOf(order: { status: string; agentId: string | null }, publisherId: string): Promise<AgentRatingEligibility> {
  if (!order.agentId) return { askable: false, reason: 'NO_AGENT' };
  if (!(RATEABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) return { askable: false, reason: 'NOT_YET' };
  if (await repository.publisherHasRatedAgent(publisherId, order.agentId)) return { askable: false, reason: 'ALREADY_RATED' };
  return { askable: true, reason: null };
}

/** `GET /orders/:id/rate-agent/eligibility` — whether the app should ask. */
export async function rateAgentEligibility(orderId: string, publisherUserId: string): Promise<AgentRatingEligibility> {
  const { order, publisherId } = await rateableOrder(orderId, publisherUserId);
  return eligibilityOf(order, publisherId);
}

/**
 * The publisher rates the agent who installed on their spot.
 *
 * Once per publisher–agent pair, for ever: the pair is the relationship, and
 * a second job is not a second vote. The partial unique on
 * (authorPublisherId, subjectId) backs it; the anchor unique backs "once
 * per order" underneath. Both read as 409 REVIEW_EXISTS.
 */
export async function rateAgent(orderId: string, input: RateInput, publisherUserId: string): Promise<ReviewRow> {
  const { order, publisherId } = await rateableOrder(orderId, publisherUserId);
  const eligibility = await eligibilityOf(order, publisherId);
  if (!eligibility.askable) {
    if (eligibility.reason === 'ALREADY_RATED') {
      throw new ApiError(409, 'REVIEW_EXISTS', 'You have already rated this agent.');
    }
    throw new ApiError(
      409,
      'CONFLICT',
      eligibility.reason === 'NO_AGENT'
        ? 'No agent installed this order, so there is nobody to rate.'
        : 'Rate the agent once the installation is verified on site.',
    );
  }
  if (await repository.findByAnchor('ORDER', order.id, 'AGENT')) {
    throw new ApiError(409, 'REVIEW_EXISTS', 'This order has already been rated.');
  }

  const review = await repository.create({
    subjectType: 'AGENT',
    subjectId: order.agentId!,
    authorUserId: publisherUserId,
    authorPublisherId: publisherId,
    authorAdvertiserId: null,
    anchorKind: 'ORDER',
    anchorId: order.id,
    rating: input.rating,
    note: input.note ?? null,
  });

  await recomputeSubject('AGENT', order.agentId!);
  return review;
}

/**
 * E7-2: `GET /agents/me/reviews` — what the agent's own screen prints. The
 * stars, the line, when, and the order that earned it; never the publisher's
 * name. The ledger row (below, through the port) is the one place the agent
 * reads who rated them — the frame draws it there and nowhere else.
 */
export type MyAgentReview = { id: string; rating: number; note: string | null; createdAt: Date; orderId: string };

export async function myAgentReviews(agentId: string, query: MyAgentReviewsQuery): Promise<ListPage<MyAgentReview>> {
  const { items, total } = await repository.listPublished('AGENT', agentId, query.page, query.pageSize, { q: query.q, sort: query.sort });
  return toListPage(
    items.map((review) => ({ id: review.id, rating: review.rating, note: review.note, createdAt: review.createdAt, orderId: review.anchorId })),
    total,
    { PUBLISHED: total },
    query,
  );
}

/**
 * The agents module's ledger feed — Lot D's port, filled by bootstrap.
 * E7-2: with the publisher's name — the ledger row prints who reviewed.
 */
export async function recentAgentReviews(agentId: string, from: Date) {
  const rows = await repository.recentForAgent(agentId, from);
  const names = await repository.publisherNames(rows.map((row) => row.authorPublisherId).filter((id): id is string => id !== null));
  return rows.map((row) => ({
    reviewId: row.id,
    rating: row.rating,
    note: row.note,
    at: row.createdAt,
    publisherName: (row.authorPublisherId && names.get(row.authorPublisherId)) || null,
  }));
}

/* ------------------------------------------------------------------ */
/* Moderation — Q104: ops may hide with a reason                       */
/* ------------------------------------------------------------------ */

async function requireReview(id: string): Promise<ReviewRow> {
  const review = await repository.findById(id);
  if (!review) throw new ApiError(404, 'NOT_FOUND', 'Review not found');
  return review;
}

/**
 * Hidden, never deleted: the row stays as the record of what was said and
 * why it was taken down, and comes out of the subject's average at once.
 */
export async function hideReview(id: string, reason: string, adminUserId: string, req?: Parameters<typeof logActivity>[2]): Promise<ReviewRow> {
  const before = await requireReview(id);
  if (before.status === 'HIDDEN') throw new ApiError(409, 'CONFLICT', 'This review is already hidden.');
  const after = await repository.setStatus(id, { status: 'HIDDEN', hiddenReason: reason, hiddenById: adminUserId });
  await recomputeSubject(before.subjectType, before.subjectId);
  await logActivity(adminUserId, 'REVIEW_HIDDEN', {
    req,
    targetType: 'Review',
    targetId: id,
    module: 'reviews',
    diff: auditDiff(before, after, ['status', 'hiddenReason']),
    metadata: { subjectType: before.subjectType, subjectId: before.subjectId, reason },
  });
  return after;
}

export async function unhideReview(id: string, adminUserId: string, req?: Parameters<typeof logActivity>[2]): Promise<ReviewRow> {
  const before = await requireReview(id);
  if (before.status === 'PUBLISHED') throw new ApiError(409, 'CONFLICT', 'This review is not hidden.');
  const after = await repository.setStatus(id, { status: 'PUBLISHED', hiddenReason: null, hiddenById: null });
  await recomputeSubject(before.subjectType, before.subjectId);
  await logActivity(adminUserId, 'REVIEW_UNHIDDEN', {
    req,
    targetType: 'Review',
    targetId: id,
    module: 'reviews',
    diff: auditDiff(before, after, ['status', 'hiddenReason']),
    metadata: { subjectType: before.subjectType, subjectId: before.subjectId },
  });
  return after;
}

/** The desk: every review, every status, by subject. */
export async function listReviews(query: ListReviewsQuery): Promise<ListPage<ReviewRow>> {
  const { items, total, counts } = await repository.listForAdmin(query);
  return toListPage(items, total, counts, query);
}

/** `GET /agents/:id/reviews` — the desk's view of one agent's stars, hidden ones included. */
export async function agentReviews(agentId: string, query: ReviewPageQuery): Promise<ListPage<ReviewRow>> {
  return listReviews({ ...query, subjectType: 'AGENT', subjectId: agentId, sort: 'NEWEST' });
}
