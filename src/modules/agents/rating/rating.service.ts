import { priorityOf, priorityWindowStart } from '../../../shared/dispatch';
import { ApiError } from '../../../shared/errors';
import { money } from '../../../shared/money';
import { prismaRatingRepository as repository } from './prisma-rating.repository';
import { agentReviewFeed } from './review-feed.port';
import {
  arrivedOnTime,
  ledgerOf,
  percentileLabel,
  percentileOf,
  RATING_WINDOW_DAYS,
  scoreOf,
  type Rating,
} from './rating.rules';

/**
 * The rating an agent sees, and the one ops see beside the offer lane.
 *
 * Read on demand from rows that already exist, and the snapshot written as a
 * side effect — which is what makes the cohort percentile a cheap query
 * instead of a scan of every agent's order history (decision 3). A snapshot
 * is a cache of a derivation, never a source: nothing reads it to build this
 * agent's own score.
 */

export type RatingView = Rating & {
  /** E7-3: the written driver's inputs as the snapshot columns hold them — a decimal string, like every figure that crosses a boundary. */
  reviewAvg: string | null;
  reviewCount: number;
  windowDays: number;
  percentile: number | null;
  percentileLabel: string | null;
  lane: 'FAST' | 'SLOWED';
  ledger: { id: string; kind: string; title: string; detail: string | null; at: Date; delta: number }[];
  computedAt: Date;
};

const windowStart = (now: Date) => new Date(now.getTime() - RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

export async function ratingFor(agentId: string, now = new Date()): Promise<RatingView> {
  const agent = await repository.findAgent(agentId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');

  const from = windowStart(now);
  const [assignments, arrivals, offers, completions, rejections, reviews, recentReviews] = await Promise.all([
    repository.assignmentTotals(agentId, from),
    repository.arrivals(agentId, from),
    repository.recentOffers(agentId, priorityWindowStart(now)),
    repository.recentCompletions(agentId, from),
    repository.recentRejections(agentId, from),
    // Lot D (Q112): the fourth driver. The snapshot columns are the source
    // here — `reviews` writes them through `setAgentReviewSnapshot` on every
    // rating, so they are current without a read of that module's table.
    repository.reviewSnapshot(agentId),
    agentReviewFeed().recentReviews(agentId, from),
  ]);

  const judged = arrivals.filter((arrival) => arrival.slotTime && arrival.checkedInAt);
  const onTime = judged.filter((arrival) => arrivedOnTime(arrival.slotTime!, arrival.checkedInAt!));

  const priority = priorityOf(offers);
  const rating = scoreOf({
    accepted: assignments.accepted,
    completed: assignments.completed,
    arrivalsJudged: judged.length,
    arrivalsOnTime: onTime.length,
    offered: priority.offered,
    declined: priority.declined,
    reviewAvg: reviews.reviewAvg,
    reviewCount: reviews.reviewCount,
  });

  // The snapshot is what the cohort query reads. Written before the
  // percentile is asked for, so this agent's own row is current in it.
  await repository.saveSnapshot({
    agentId,
    city: agent.city,
    score: rating.score,
    completionRate: rating.drivers.find((driver) => driver.key === 'completion')?.rate ?? null,
    onTimeRate: rating.drivers.find((driver) => driver.key === 'onTime')?.rate ?? null,
    rejectionRate: rating.drivers.find((driver) => driver.key === 'rejection')?.rate ?? null,
    sample: rating.sample,
    computedAt: now,
  });

  const cohort = agent.city ? await repository.cohortScores(agent.city) : [];
  const percentile = percentileOf(rating.score, cohort);

  const onTimeByOrder = new Map(judged.map((arrival) => [arrival.orderId, arrivedOnTime(arrival.slotTime!, arrival.checkedInAt!)]));
  const ledger = ledgerOf({
    completions: completions.map((completion) => ({
      orderId: completion.orderId,
      at: completion.at,
      campaignName: completion.campaignName,
      onTime: onTimeByOrder.get(completion.orderId) ?? null,
    })),
    rejections,
    reviews: recentReviews,
  });

  return {
    ...rating,
    // E7-3: the console prints the stars beside the score, not only the driver's rate.
    reviewAvg: reviews.reviewAvg === null ? null : money(reviews.reviewAvg),
    reviewCount: reviews.reviewCount,
    windowDays: RATING_WINDOW_DAYS,
    percentile,
    percentileLabel: percentileLabel(percentile, agent.city),
    lane: priority.lane,
    ledger,
    computedAt: now,
  };
}

/**
 * Lot D (Q112): `reviews` recomputed a publisher's stars for this agent and
 * hands the aggregate here — the one write another module makes to
 * `AgentRating`, through this door so the columns stay this module's. A
 * decimal string, like every other figure that crosses a module boundary.
 */
export async function setAgentReviewSnapshot(
  agentId: string,
  snapshot: { reviewAvg: string | null; reviewCount: number },
): Promise<void> {
  const agent = await repository.findAgent(agentId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  await repository.saveReviewSnapshot(agentId, agent.city, snapshot);
}
